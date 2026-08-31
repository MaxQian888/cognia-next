//! The tray quick panel — a popover window anchored to the tray icon.
//!
//! Clicking the tray icon opens a small, frameless, always-on-top window
//! (label `"tray-panel"`, route `/tray-panel`) instead of just toggling the
//! main window. The panel is where the user delegates a task or fires a quick
//! action without bringing the whole app forward.
//!
//! ## Why a real OS window
//!
//! The same reason the pet uses one (`pet_window/popup.rs`): an OS window
//! renders the panel at its natural size, is never clipped by a parent, and
//! gets native blur-to-close for free — clicking anywhere else dismisses it
//! exactly like a system menu. A menu built with `tauri::menu` could not host a
//! text input at all, which is the whole point of the surface.
//!
//! ## Anchoring
//!
//! `TrayIconEvent::Click` carries the icon's screen `rect`, which we stash in
//! [`TrayPanelAnchorStore`] on every click. Placement is
//! [`resolve_panel_placement`] — pure, so the geometry is unit-tested here
//! while the live window ops are smoke-tested via `pnpm tauri dev` (the same
//! constraint documented in `pet_window/mod.rs`: Tauri's `test` feature is not
//! enabled in this project, so `mock_app()` cannot drive real windows).
//!
//! ## Renderer contract
//!
//! Rust owns the window and the anchor; the renderer owns the content, the
//! action catalogue, and i18n — the same split the tray menu already uses. The
//! panel talks to the main window with `emitTo("main", "tray-panel://run", …)`
//! rather than through Rust, mirroring how the selection toolbar reports back.

use std::sync::atomic::{AtomicBool, Ordering};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Runtime, WindowEvent};

// The shared overlay seam the pet windows pioneered and the fleet island
// already borrows: non-activating NSPanel reclassing, generation-guarded
// reveals, awaited AppKit conversion. Reused verbatim — the tray panel has the
// same requirements (float over everything, never steal activation, survive a
// dismissal that lands mid-conversion).
use crate::pet_window::{
    begin_overlay_panel_open, cancel_overlay_panel_reveal, configure_overlay_panel,
    current_overlay_panel_generation, detach_overlay_panel, overlay_panel_generation_is_current,
    reveal_overlay_panel, OverlayPanelRole,
};

/// This module's role in the shared overlay-panel state machine.
const PANEL_ROLE: OverlayPanelRole = OverlayPanelRole::TrayPanel;

/// Window label of the quick panel. Kept in lockstep with
/// `lib/pet/window-role.ts` (`TRAY_PANEL_WINDOW_LABEL`) so the webview resolves
/// the `"tray-panel"` role and the shared root layout renders presentation only.
pub const TRAY_PANEL_LABEL: &str = "tray-panel";

/// Rust → renderer: the panel was hidden by something the renderer did not
/// initiate (blur, tray re-click, Escape from another surface). Without it the
/// panel's own "open" state desyncs from the native window, exactly like the
/// pet popup's `pet-popup://hidden`.
pub const TRAY_PANEL_HIDDEN_EVENT: &str = "tray-panel://hidden";

/// Rust → renderer: the panel was just revealed. The panel view resets its
/// draft-agnostic transient state (selected action, validation errors) on this
/// so a re-open never shows the previous visit's half-filled form.
pub const TRAY_PANEL_SHOWN_EVENT: &str = "tray-panel://shown";

/// Initial logical size, used only until the renderer measures its content and
/// calls [`tray_panel_resize`]. Persisted afterwards so the next cold open
/// starts at the size the user last saw instead of jumping.
pub const DEFAULT_PANEL_WIDTH: f64 = 380.0;
pub const DEFAULT_PANEL_HEIGHT: f64 = 460.0;

/// Gap (physical px) between the tray icon and the panel edge.
pub const PANEL_GAP_PX: f64 = 8.0;
/// Minimum gap kept between the panel and the work-area edges.
pub const PANEL_EDGE_MARGIN_PX: f64 = 8.0;

/// Clamp for renderer-supplied sizes. A measurement bug must not be able to
/// create a 1px-tall or screen-swallowing window.
const MIN_PANEL_WIDTH: f64 = 240.0;
const MAX_PANEL_WIDTH: f64 = 720.0;
const MIN_PANEL_HEIGHT: f64 = 120.0;
const MAX_PANEL_HEIGHT: f64 = 900.0;

/// What a left-click on the tray icon does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum TrayLeftClickAction {
    /// Open the quick panel (Claude-Code-style menu-bar popover). Default:
    /// this is the feature's entry point, and the old behaviour is still one
    /// click away inside the panel.
    #[default]
    Panel,
    /// Legacy behaviour — show/hide the main window.
    ToggleWindow,
    /// Do nothing; the menu (right-click) remains the only tray affordance.
    None,
}

/// Persisted panel preferences (`<cognia-home>/tray-panel.json`).
///
/// This lives in a file rather than the renderer's Tauri-store prefs because
/// the tray click handler runs with no renderer involvement at all — the main
/// window may be hidden, still booting, or closed to the tray. `#[serde(default)]`
/// keeps files written by older builds readable.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct TrayPanelConfig {
    /// What a left-click on the tray icon does.
    pub left_click: TrayLeftClickAction,
    /// Last size the renderer measured, in logical px.
    pub width: f64,
    pub height: f64,
}

impl Default for TrayPanelConfig {
    fn default() -> Self {
        Self {
            left_click: TrayLeftClickAction::default(),
            width: DEFAULT_PANEL_WIDTH,
            height: DEFAULT_PANEL_HEIGHT,
        }
    }
}

impl TrayPanelConfig {
    /// Fold a renderer-measured size in, clamped. Returns `true` when the
    /// stored size actually moved (the caller skips the disk write otherwise —
    /// a `ResizeObserver` can fire many times per second).
    fn absorb_size(&mut self, width: f64, height: f64) -> bool {
        let width = clamp_dimension(width, MIN_PANEL_WIDTH, MAX_PANEL_WIDTH, DEFAULT_PANEL_WIDTH);
        let height = clamp_dimension(
            height,
            MIN_PANEL_HEIGHT,
            MAX_PANEL_HEIGHT,
            DEFAULT_PANEL_HEIGHT,
        );
        // Sub-pixel churn is not worth a disk write.
        if (self.width - width).abs() < 0.5 && (self.height - height).abs() < 0.5 {
            return false;
        }
        self.width = width;
        self.height = height;
        true
    }
}

/// Clamp a renderer-supplied dimension, substituting `fallback` for anything
/// non-finite (NaN/∞ survive `f64::clamp` as NaN and would poison the window).
fn clamp_dimension(value: f64, min: f64, max: f64, fallback: f64) -> f64 {
    if !value.is_finite() {
        return fallback;
    }
    value.clamp(min, max)
}

fn config_path() -> Option<std::path::PathBuf> {
    crate::agents::paths::cognia_home().map(|home| home.join("tray-panel.json"))
}

pub fn load_config() -> TrayPanelConfig {
    config_path()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_config(cfg: &TrayPanelConfig) -> Result<(), String> {
    let path = config_path().ok_or_else(|| "cannot resolve cognia home".to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

/* ── Anchor ───────────────────────────────────────────────────────────── */

/// A physical-pixel rectangle. Both the tray icon rect and the monitor work
/// area are expressed in these so the placement math never mixes units.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl PanelRect {
    pub fn center_x(&self) -> f64 {
        self.x + self.width / 2.0
    }
    pub fn center_y(&self) -> f64 {
        self.y + self.height / 2.0
    }
}

/// Last tray-icon rectangle reported by the OS, in physical px.
///
/// Recorded on every tray click (including right-clicks, which open the menu)
/// so a panel opened from a menu item or a command still lands under the icon.
#[derive(Default)]
pub struct TrayPanelAnchorStore {
    inner: Mutex<Option<PanelRect>>,
}

impl TrayPanelAnchorStore {
    pub fn set(&self, rect: PanelRect) {
        *self.inner.lock() = Some(rect);
    }

    pub fn get(&self) -> Option<PanelRect> {
        *self.inner.lock()
    }
}

/// Normalise the tray icon rectangle the OS reports into physical pixels.
///
/// `TrayIconEvent`'s `rect` is a `tauri::Rect` whose position and size are each
/// independently either logical or physical (macOS reports logical, Windows
/// physical), so both halves have to be converted rather than assumed. Pure so
/// the unit conversion is pinned by tests — getting it wrong puts the panel a
/// whole screen away on a HiDPI display, which no `cargo test` would catch.
pub fn anchor_from_tray_rect(rect: &tauri::Rect, scale_factor: f64) -> PanelRect {
    let scale = if scale_factor.is_finite() && scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    };
    let position = rect.position.to_physical::<f64>(scale);
    let size = rect.size.to_physical::<f64>(scale);
    PanelRect {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    }
}

/// Whether the panel window is currently revealed. The renderer reveals the
/// window itself after first paint, so `is_visible()` lags behind intent by a
/// frame or two — a toggle that read it would re-open a panel the user just
/// dismissed with a second tray click.
static PANEL_OPEN: AtomicBool = AtomicBool::new(false);

pub fn is_open() -> bool {
    PANEL_OPEN.load(Ordering::SeqCst)
}

/// Marks an open attempt as active and restores the closed state on every
/// early-return/error path unless the caller explicitly commits success.
struct PanelOpenAttempt {
    committed: bool,
}

impl PanelOpenAttempt {
    fn begin() -> Self {
        PANEL_OPEN.store(true, Ordering::SeqCst);
        Self { committed: false }
    }

    fn commit(mut self) {
        self.committed = true;
    }
}

impl Drop for PanelOpenAttempt {
    fn drop(&mut self) {
        if !self.committed {
            PANEL_OPEN.store(false, Ordering::SeqCst);
        }
    }
}

/* ── Placement ────────────────────────────────────────────────────────── */

/// Resolve the panel's physical top-left.
///
/// - Horizontally centred on the tray icon, then clamped inside the work area.
/// - Vertically flipped by which half of the screen the icon sits in: an icon
///   in the top half (macOS menu bar, top-docked Windows taskbar) drops the
///   panel BELOW it; an icon in the bottom half (the usual Windows taskbar)
///   raises it ABOVE. This is the only rule that works on both platforms
///   without a `cfg`, because it reads where the bar actually is rather than
///   assuming.
/// - Finally clamped so the whole panel stays inside the work area, which also
///   covers the degenerate case of a panel taller than the screen.
pub fn resolve_panel_placement(
    anchor: PanelRect,
    size: (f64, f64),
    work_area: PanelRect,
    gap: f64,
) -> (f64, f64) {
    let (width, height) = size;

    let min_x = work_area.x + PANEL_EDGE_MARGIN_PX;
    // `max` guards the case where the panel is wider than the work area: the
    // clamp range would otherwise be inverted and `clamp` panics on min > max.
    let max_x = (work_area.x + work_area.width - width - PANEL_EDGE_MARGIN_PX).max(min_x);
    let x = (anchor.center_x() - width / 2.0).clamp(min_x, max_x);

    let anchor_in_top_half = anchor.center_y() < work_area.center_y();
    let y_raw = if anchor_in_top_half {
        anchor.y + anchor.height + gap
    } else {
        anchor.y - gap - height
    };

    let min_y = work_area.y + PANEL_EDGE_MARGIN_PX;
    let max_y = (work_area.y + work_area.height - height - PANEL_EDGE_MARGIN_PX).max(min_y);
    let y = y_raw.clamp(min_y, max_y);

    (x.round(), y.round())
}

/// Work area (physical px) of the monitor holding `point`, falling back to the
/// primary monitor and finally to a conservative 1920x1080 desktop — the same
/// ladder `pet_window::work_area_for` walks.
fn work_area_for<R: Runtime>(app: &AppHandle<R>, point: Option<(f64, f64)>) -> PanelRect {
    let monitor = point
        .and_then(|(x, y)| app.monitor_from_point(x, y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    match monitor {
        Some(monitor) => {
            let rect = monitor.work_area();
            PanelRect {
                x: rect.position.x as f64,
                y: rect.position.y as f64,
                width: rect.size.width as f64,
                height: rect.size.height as f64,
            }
        }
        None => PanelRect {
            x: 0.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
        },
    }
}

/// Where to anchor when no tray click has been observed yet — the panel was
/// opened from a menu item, a shortcut, or the settings preview.
///
/// macOS keeps its status items in the top-right of the menu bar; Windows and
/// most Linux desktops keep the notification area in the bottom-right. Anchor
/// to a zero-height rect just outside the corresponding work-area edge so
/// [`resolve_panel_placement`] flips the panel the right way.
fn fallback_anchor(work_area: PanelRect) -> PanelRect {
    #[cfg(target_os = "macos")]
    let y = work_area.y - 1.0;
    #[cfg(not(target_os = "macos"))]
    let y = work_area.y + work_area.height + 1.0;

    PanelRect {
        x: work_area.x + work_area.width - 1.0,
        y,
        width: 0.0,
        height: 0.0,
    }
}

/* ── Window lifecycle ─────────────────────────────────────────────────── */

/// Hide the panel. Cheap to re-show, so we hide rather than destroy.
pub fn close_panel_inner<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    cancel_overlay_panel_reveal(PANEL_ROLE);
    PANEL_OPEN.store(false, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window(TRAY_PANEL_LABEL) {
        window.hide().map_err(|e| e.to_string())?;
        let _ = app.emit(TRAY_PANEL_HIDDEN_EVENT, serde_json::Value::Null);
    }
    Ok(())
}

/// Open (or re-show + reposition) the panel anchored under the tray icon.
///
/// Like the pet popup, the window is created `visible(false)` and revealed by
/// the renderer after its first painted frame — a `transparent(true)` window
/// shown before the WebView commits paints an opaque rectangle on Windows.
pub fn open_panel_inner<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let cfg = load_config();
    let anchor = app
        .try_state::<std::sync::Arc<TrayPanelAnchorStore>>()
        .and_then(|store| store.get());

    let work_area = work_area_for(app, anchor.map(|r| (r.center_x(), r.center_y())));
    let anchor = anchor.unwrap_or_else(|| fallback_anchor(work_area));

    // The config size is logical; placement is physical. Scale through the
    // monitor the panel will actually land on.
    let scale = app
        .monitor_from_point(anchor.center_x(), anchor.center_y())
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten())
        .map(|m| m.scale_factor())
        .unwrap_or(1.0);
    let physical_size = (cfg.width * scale, cfg.height * scale);
    let (x, y) = resolve_panel_placement(anchor, physical_size, work_area, PANEL_GAP_PX);

    let open_attempt = PanelOpenAttempt::begin();

    if let Some(window) = app.get_webview_window(TRAY_PANEL_LABEL) {
        window
            .set_size(LogicalSize::new(cfg.width, cfg.height))
            .map_err(|e| e.to_string())?;
        window
            .set_position(PhysicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        let generation = begin_overlay_panel_open(PANEL_ROLE);
        if let Err(error) = reveal_overlay_panel(&window, PANEL_ROLE, true, generation) {
            cancel_overlay_panel_reveal(PANEL_ROLE);
            PANEL_OPEN.store(false, Ordering::SeqCst);
            return Err(error);
        }
        let _ = app.emit(TRAY_PANEL_SHOWN_EVENT, serde_json::Value::Null);
        open_attempt.commit();
        return Ok(());
    }

    let generation = begin_overlay_panel_open(PANEL_ROLE);

    let window = tauri::WebviewWindowBuilder::new(
        app,
        TRAY_PANEL_LABEL,
        tauri::WebviewUrl::App("tray-panel".into()),
    )
    .transparent(true)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .shadow(false)
    .visible(false)
    .inner_size(cfg.width, cfg.height)
    .build()
    .map_err(|error| {
        cancel_overlay_panel_reveal(PANEL_ROLE);
        PANEL_OPEN.store(false, Ordering::SeqCst);
        error.to_string()
    })?;

    // The app-wide menu bar attaches to every new window on Windows/Linux —
    // detach it before the first reveal so no File/Edit strip paints inside a
    // frameless popover (same fix as `pet_window/popup.rs`).
    let _ = window.remove_menu();

    if let Err(error) = window.set_position(PhysicalPosition::new(x, y)) {
        cancel_overlay_panel_reveal(PANEL_ROLE);
        PANEL_OPEN.store(false, Ordering::SeqCst);
        let _ = window.close();
        return Err(error.to_string());
    }

    // Native blur-to-close, exactly like a system menu. Re-look-up by label so
    // the closure owns no window handle (avoids a self-referential capture).
    let app_handle = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Focused(false)) {
            cancel_overlay_panel_reveal(PANEL_ROLE);
            PANEL_OPEN.store(false, Ordering::SeqCst);
            if let Some(w) = app_handle.get_webview_window(TRAY_PANEL_LABEL) {
                let _ = w.hide();
                let _ = app_handle.emit(TRAY_PANEL_HIDDEN_EVENT, serde_json::Value::Null);
            }
        }
    });

    // macOS: reclass to a non-activating NSPanel so opening the panel never
    // steals activation from whatever the user was doing. `to_panel`'s raw
    // AppKit calls trap off-main, so this waits — the command must not report
    // success while a hidden ordinary NSWindow is all that exists.
    if let Err(error) = configure_overlay_panel(&window, PANEL_ROLE) {
        cancel_overlay_panel_reveal(PANEL_ROLE);
        PANEL_OPEN.store(false, Ordering::SeqCst);
        let _ = detach_overlay_panel(&window);
        let _ = window.close();
        return Err(error);
    }
    if !overlay_panel_generation_is_current(PANEL_ROLE, generation) {
        // A dismissal landed while AppKit was still converting — this build is
        // stale and is responsible for cleaning itself up.
        let _ = detach_overlay_panel(&window);
        let _ = window.close();
        return Ok(());
    }

    let _ = app.emit(TRAY_PANEL_SHOWN_EVENT, serde_json::Value::Null);
    open_attempt.commit();
    Ok(())
}

/// Toggle the panel. Used by the tray left-click handler and the
/// `tray-panel-toggle` native menu action.
pub fn toggle_panel_inner<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    if is_open() {
        close_panel_inner(app)
    } else {
        open_panel_inner(app)
    }
}

/// Record the tray icon's screen rectangle so the next open lands under it.
/// Called from the tray icon event handler for every click, enter and move.
pub fn record_anchor<R: Runtime>(app: &AppHandle<R>, rect: PanelRect) {
    if let Some(store) = app.try_state::<std::sync::Arc<TrayPanelAnchorStore>>() {
        store.set(rect);
    }
}

/* ── Commands ─────────────────────────────────────────────────────────── */

#[tauri::command]
pub async fn open_tray_panel(app: AppHandle) -> Result<(), String> {
    open_panel_inner(&app)
}

#[tauri::command]
pub async fn close_tray_panel(app: AppHandle) -> Result<(), String> {
    close_panel_inner(&app)
}

#[tauri::command]
pub async fn toggle_tray_panel(app: AppHandle) -> Result<(), String> {
    toggle_panel_inner(&app)
}

/// Reveal the panel after its first painted frame (macOS NSPanel path). The
/// renderer calls this from `schedulePetWindowReveal`; off macOS the shared
/// helper shows the window directly.
#[tauri::command]
pub async fn reveal_tray_panel(app: AppHandle, focus: bool) -> Result<(), String> {
    let window = app
        .get_webview_window(TRAY_PANEL_LABEL)
        .ok_or_else(|| format!("window '{TRAY_PANEL_LABEL}' no longer exists"))?;
    let generation = current_overlay_panel_generation(PANEL_ROLE);
    reveal_overlay_panel(&window, PANEL_ROLE, focus, generation)
}

/// Fit the window to the panel's measured content (logical px). The size is
/// persisted so the next cold open starts there instead of jumping.
#[tauri::command]
pub async fn tray_panel_resize(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    let mut cfg = load_config();
    let changed = cfg.absorb_size(width, height);
    if let Some(window) = app.get_webview_window(TRAY_PANEL_LABEL) {
        window
            .set_size(LogicalSize::new(cfg.width, cfg.height))
            .map_err(|e| e.to_string())?;
    }
    if changed {
        save_config(&cfg)?;
    }
    Ok(())
}

/// Run one of the tray's native actions from the quick panel.
///
/// Shares `tray::run_native_action` with the OS menu so "Open Cognia" means the
/// same thing from either surface, including the legacy `tray://*` events the
/// renderer's existing listeners consume.
#[tauri::command]
pub async fn tray_run_native_action(app: AppHandle, action: String) -> Result<(), String> {
    #[cfg(desktop)]
    {
        super::run_native_action(&app, &action)
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, action);
        Err("tray not available on this platform".into())
    }
}

#[tauri::command]
pub async fn tray_panel_get_config() -> Result<TrayPanelConfig, String> {
    Ok(load_config())
}

/// Persist the left-click behaviour. Only the setting the settings UI owns —
/// the size is written by [`tray_panel_resize`] and must not be clobbered by a
/// stale copy the renderer is holding.
#[tauri::command]
pub async fn tray_panel_set_left_click(action: TrayLeftClickAction) -> Result<(), String> {
    let mut cfg = load_config();
    if cfg.left_click == action {
        return Ok(());
    }
    cfg.left_click = action;
    save_config(&cfg)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_attempt_rolls_back_unless_committed() {
        PANEL_OPEN.store(false, Ordering::SeqCst);
        {
            let _attempt = PanelOpenAttempt::begin();
            assert!(is_open());
        }
        assert!(!is_open());

        PanelOpenAttempt::begin().commit();
        assert!(is_open());
        PANEL_OPEN.store(false, Ordering::SeqCst);
    }

    fn work_area() -> PanelRect {
        // A 1920x1080 display with a 25px macOS menu bar reserved at the top.
        PanelRect {
            x: 0.0,
            y: 25.0,
            width: 1920.0,
            height: 1055.0,
        }
    }

    #[test]
    fn label_matches_renderer_contract() {
        // Must stay in lockstep with `lib/pet/window-role.ts`.
        assert_eq!(TRAY_PANEL_LABEL, "tray-panel");
    }

    #[test]
    fn menu_bar_icon_drops_the_panel_below_itself() {
        // macOS: the status item sits in the menu bar, ABOVE the work area.
        let anchor = PanelRect {
            x: 1700.0,
            y: 0.0,
            width: 24.0,
            height: 24.0,
        };
        let (x, y) = resolve_panel_placement(anchor, (380.0, 460.0), work_area(), PANEL_GAP_PX);
        // Below the icon (0 + 24 + 8 = 32), then nudged to the work-area top
        // margin (25 + 8 = 33), which is the tighter of the two constraints.
        assert_eq!(y, 33.0, "panel hangs below the menu bar icon");
        assert!(
            y > anchor.y + anchor.height,
            "never overlaps the icon itself"
        );
        // Centred on the icon: 1712 - 190 = 1522.
        assert_eq!(x, 1522.0);
    }

    #[test]
    fn taskbar_icon_raises_the_panel_above_itself() {
        // Windows: the notification area sits at the bottom of the screen.
        let bottom_work = PanelRect {
            x: 0.0,
            y: 0.0,
            width: 1920.0,
            height: 1040.0,
        };
        let anchor = PanelRect {
            x: 1800.0,
            y: 1044.0,
            width: 24.0,
            height: 32.0,
        };
        let (_, y) = resolve_panel_placement(anchor, (380.0, 460.0), bottom_work, PANEL_GAP_PX);
        // Above the icon (1044 - 8 - 460 = 576), then pulled up to the
        // work-area bottom margin (1040 - 460 - 8 = 572).
        assert_eq!(y, 572.0);
        assert!(y + 460.0 < anchor.y, "sits entirely above the taskbar icon");
    }

    #[test]
    fn panel_is_clamped_inside_the_work_area_horizontally() {
        // An icon hard against the right edge would otherwise push half the
        // panel off-screen.
        let anchor = PanelRect {
            x: 1910.0,
            y: 0.0,
            width: 10.0,
            height: 24.0,
        };
        let (x, _) = resolve_panel_placement(anchor, (380.0, 460.0), work_area(), PANEL_GAP_PX);
        assert_eq!(x, 1920.0 - 380.0 - PANEL_EDGE_MARGIN_PX);
        assert!(x + 380.0 <= 1920.0);
    }

    #[test]
    fn panel_is_clamped_inside_the_work_area_vertically() {
        // A panel taller than the screen pins to the top edge rather than
        // hanging off the bottom.
        let anchor = PanelRect {
            x: 900.0,
            y: 0.0,
            width: 24.0,
            height: 24.0,
        };
        let (_, y) = resolve_panel_placement(anchor, (380.0, 4000.0), work_area(), PANEL_GAP_PX);
        assert_eq!(y, 25.0 + PANEL_EDGE_MARGIN_PX);
    }

    #[test]
    fn placement_never_inverts_the_clamp_range_for_an_oversized_panel() {
        // `f64::clamp` panics when min > max. A panel wider than the work area
        // must pin to the left margin, not blow up.
        let narrow = PanelRect {
            x: 0.0,
            y: 0.0,
            width: 200.0,
            height: 200.0,
        };
        let anchor = PanelRect {
            x: 100.0,
            y: 0.0,
            width: 10.0,
            height: 10.0,
        };
        let (x, y) = resolve_panel_placement(anchor, (900.0, 900.0), narrow, PANEL_GAP_PX);
        assert_eq!(x, PANEL_EDGE_MARGIN_PX);
        assert_eq!(y, PANEL_EDGE_MARGIN_PX);
    }

    #[test]
    fn config_defaults_to_opening_the_panel() {
        // The whole point of the feature: a fresh install gets the popover.
        let cfg = TrayPanelConfig::default();
        assert_eq!(cfg.left_click, TrayLeftClickAction::Panel);
        assert_eq!(cfg.width, DEFAULT_PANEL_WIDTH);
        assert_eq!(cfg.height, DEFAULT_PANEL_HEIGHT);
    }

    #[test]
    fn config_deserializes_a_partial_file_from_an_older_build() {
        let cfg: TrayPanelConfig =
            serde_json::from_str(r#"{"leftClick":"toggle-window"}"#).unwrap();
        assert_eq!(cfg.left_click, TrayLeftClickAction::ToggleWindow);
        assert_eq!(cfg.width, DEFAULT_PANEL_WIDTH);
    }

    #[test]
    fn left_click_action_round_trips_through_kebab_case() {
        for (action, json) in [
            (TrayLeftClickAction::Panel, "\"panel\""),
            (TrayLeftClickAction::ToggleWindow, "\"toggle-window\""),
            (TrayLeftClickAction::None, "\"none\""),
        ] {
            assert_eq!(serde_json::to_string(&action).unwrap(), json);
            assert_eq!(
                serde_json::from_str::<TrayLeftClickAction>(json).unwrap(),
                action
            );
        }
    }

    #[test]
    fn absorb_size_clamps_and_reports_change() {
        let mut cfg = TrayPanelConfig::default();
        assert!(cfg.absorb_size(400.0, 500.0));
        assert_eq!((cfg.width, cfg.height), (400.0, 500.0));

        // Sub-pixel churn from a ResizeObserver must not trigger a disk write.
        assert!(!cfg.absorb_size(400.2, 500.1));

        // Out-of-range measurements clamp rather than creating a broken window.
        assert!(cfg.absorb_size(10.0, 10_000.0));
        assert_eq!((cfg.width, cfg.height), (MIN_PANEL_WIDTH, MAX_PANEL_HEIGHT));
    }

    #[test]
    fn absorb_size_substitutes_defaults_for_non_finite_measurements() {
        // NaN survives `clamp` as NaN and would poison `set_size`. Infinities
        // take the same path — a measurement that isn't a real number tells us
        // nothing, so the shipped default is a better answer than the max.
        let mut cfg = TrayPanelConfig {
            width: 999.0,
            height: 999.0,
            ..Default::default()
        };
        assert!(cfg.absorb_size(f64::NAN, f64::INFINITY));
        assert_eq!(cfg.width, DEFAULT_PANEL_WIDTH);
        assert_eq!(cfg.height, DEFAULT_PANEL_HEIGHT);

        assert!(cfg.absorb_size(f64::NEG_INFINITY, 700.0));
        assert_eq!(cfg.width, DEFAULT_PANEL_WIDTH);
        assert_eq!(cfg.height, 700.0);
    }

    #[test]
    fn anchor_store_round_trips() {
        let store = TrayPanelAnchorStore::default();
        assert!(store.get().is_none());
        let rect = PanelRect {
            x: 10.0,
            y: 20.0,
            width: 30.0,
            height: 40.0,
        };
        store.set(rect);
        assert_eq!(store.get(), Some(rect));
        assert_eq!(rect.center_x(), 25.0);
        assert_eq!(rect.center_y(), 40.0);
    }

    #[test]
    fn tray_rect_converts_logical_coordinates_at_retina_scale() {
        // macOS reports the status-item rect in logical points. At 2x a naive
        // pass-through would anchor the panel at half its real position.
        let rect = tauri::Rect {
            position: tauri::Position::Logical(tauri::LogicalPosition::new(850.0, 0.0)),
            size: tauri::Size::Logical(tauri::LogicalSize::new(24.0, 24.0)),
        };
        let anchor = anchor_from_tray_rect(&rect, 2.0);
        assert_eq!(anchor.x, 1700.0);
        assert_eq!(anchor.width, 48.0);
    }

    #[test]
    fn tray_rect_passes_physical_coordinates_through_unscaled() {
        // Windows reports physical pixels — the scale factor must be ignored.
        let rect = tauri::Rect {
            position: tauri::Position::Physical(tauri::PhysicalPosition::new(1800, 1044)),
            size: tauri::Size::Physical(tauri::PhysicalSize::new(24, 32)),
        };
        let anchor = anchor_from_tray_rect(&rect, 2.0);
        assert_eq!(anchor.x, 1800.0);
        assert_eq!(anchor.y, 1044.0);
        assert_eq!(anchor.height, 32.0);
    }

    #[test]
    fn tray_rect_falls_back_to_1x_for_a_bogus_scale_factor() {
        let rect = tauri::Rect {
            position: tauri::Position::Logical(tauri::LogicalPosition::new(100.0, 10.0)),
            size: tauri::Size::Logical(tauri::LogicalSize::new(20.0, 20.0)),
        };
        for scale in [0.0, -1.0, f64::NAN] {
            let anchor = anchor_from_tray_rect(&rect, scale);
            assert_eq!(anchor.x, 100.0);
            assert_eq!(anchor.width, 20.0);
        }
    }

    #[test]
    fn fallback_anchor_sits_on_the_platform_tray_edge() {
        let wa = work_area();
        let anchor = fallback_anchor(wa);
        assert_eq!(anchor.x, wa.x + wa.width - 1.0);
        // Whichever edge it picks, the resolved panel must land on-screen.
        let (x, y) = resolve_panel_placement(anchor, (380.0, 460.0), wa, PANEL_GAP_PX);
        assert!(x >= wa.x && x + 380.0 <= wa.x + wa.width);
        assert!(y >= wa.y && y + 460.0 <= wa.y + wa.height);
    }
}
