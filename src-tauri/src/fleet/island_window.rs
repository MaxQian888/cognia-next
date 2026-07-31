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
//! lands hover on it) while the renderer pads its card's CONTENT — not the
//! card itself, whose body runs to the top edge so it reads as one shape with
//! the housing — below `NSScreen.safeAreaInsets.top`, pushed to it via the
//! `island_resize` return value and the `fleet://island-geometry` event. On
//! Windows/Linux the work area is the correct taskbar-aware anchor and the
//! inset is always 0.
//!
//! Live window ops can't run under `tauri::test::mock_app()` on this
//! project's toolchains (same constraint documented in `pet_window/mod.rs`),
//! so only the pure placement math is unit-tested; the runtime behavior is
//! covered by `tauri-smoke`.

use crate::fleet::island_space::{self, Rect};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, Runtime, WebviewWindow};

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

/// How many hover ticks pass between geometry samples. The geometry probe is
/// cheap in the common case (the menu-bar delta short-circuits before any
/// window enumeration — see `island_space`), but there is no reason to run it
/// at cursor cadence: a Space switch is a human-scale event.
const GEOMETRY_SAMPLE_EVERY_TICKS: u32 = 4;

/// Single-flight guard for the hover monitor task (mirrors the runtime's
/// `reaper_running` pattern).
static HOVER_MONITOR_RUNNING: AtomicBool = AtomicBool::new(false);

/// Per-display notch heights (physical px), keyed by [`monitor_cache_key`].
///
/// A display's camera housing is a **physical property** — it does not come and
/// go with the menu bar. `NSScreen.safeAreaInsets.top`, however, is queried
/// against the current Space, and Apple documents no guarantee that it keeps
/// reporting the housing once the menu bar is hidden. Caching the largest value
/// ever observed per display makes the island's notch padding Space-independent
/// no matter which way that API behaves, which is the other half of the fix
/// begun when the anchor moved off `work_area` (see the module docs).
static NOTCH_CACHE: OnceLock<Mutex<HashMap<String, f64>>> = OnceLock::new();

fn notch_cache() -> &'static Mutex<HashMap<String, f64>> {
    NOTCH_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Fold a fresh `safeAreaInsets.top` sample into the cached value: monotonic,
/// never negative. Pure for unit tests.
pub(crate) fn fold_notch_sample(cached: f64, sampled: f64) -> f64 {
    let sampled = if sampled.is_finite() { sampled } else { 0.0 };
    cached.max(sampled).max(0.0)
}

/// Stable identity for the notch cache. `Monitor::name` when the OS provides
/// one, else a synthetic key from the display's geometry — good enough to
/// distinguish concurrently-connected displays, which is all the cache needs.
fn monitor_cache_key(monitor: &tauri::Monitor) -> String {
    if let Some(name) = monitor.name() {
        if !name.is_empty() {
            return name.clone();
        }
    }
    let p = monitor.position();
    let s = monitor.size();
    format!(
        "@{},{} {}x{} @{}",
        p.x,
        p.y,
        s.width,
        s.height,
        monitor.scale_factor()
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IslandGeometry {
    /// Top safe-area inset (logical px) of the island's current display —
    /// the notch height on built-in notched displays, 0 everywhere else.
    pub top_inset: f64,
    /// Whether the island should withdraw because a full-screen app owns its
    /// display. This is the *effective* flag, not the raw verdict: it is only
    /// ever true when the user turned [`IslandConfig::hide_on_fullscreen`] on.
    /// While it is true the renderer suppresses the idle pill entirely (the top
    /// strip belongs to that app) and only materializes when a session needs the
    /// user. See `island_space` for the verdict itself.
    pub fullscreen: bool,
}

/// Persisted island preferences (`<cognia-home>/island-window.json`). Written
/// by `island_set_monitor`, read on every placement so the tray-toggle path
/// (which never goes through the renderer) honors the choice too.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct IslandConfig {
    /// Preferred monitor name (`Monitor::name`). `None` → primary monitor.
    pub monitor: Option<String>,
    /// Whether the island was showing when the app last quit, so a relaunch can
    /// put it back. Without this the monitor preference survived a restart but
    /// the island itself did not — the ingress came back up and kept collecting
    /// events with no overlay to show them in, which reads as "monitoring is
    /// broken" rather than "you closed the window". `#[serde(default)]` keeps
    /// config files written before this field readable (they restore closed).
    pub open: bool,
    /// Withdraw the island completely while a full-screen app owns its display?
    ///
    /// Default **false**: the island floats over every Space (that is what the
    /// panel's `CanJoinAllSpaces | FullScreenAuxiliary` collection behavior is
    /// for) and a user who opened a status overlay expects to see it there too.
    /// This shipped as unconditional behavior first, and read as "the island only
    /// works on Cognia's own desktop" — a bug, not a courtesy. Turning it on
    /// restores yielding the top strip, for people watching video or presenting;
    /// even then a session that needs the user still materializes the island.
    ///
    /// Gating the flag here rather than in the renderer also skips
    /// `island_space`'s `CGWindowListCopyWindowInfo` sweep entirely while it is
    /// off, which is now the common case.
    pub hide_on_fullscreen: bool,
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
    /// Whether a full-screen app owns this display right now.
    fullscreen: bool,
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
            fullscreen: false,
        }
    }

    fn geometry(&self) -> IslandGeometry {
        IslandGeometry {
            top_inset: self.top_inset_logical(),
            fullscreen: self.fullscreen,
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
/// renderer pads the card's content below it) so the strip level with the
/// camera housing still catches slam-to-top hover. Pure for unit tests.
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

/// The monitor the island should live on: `preferred` when that monitor is
/// still connected, else the primary. Takes the name rather than reading the
/// config so a caller that already loaded it (every placement does — it needs
/// `hide_on_fullscreen` from the same file) doesn't re-read from disk.
fn resolve_monitor_named<R: Runtime>(
    app: &AppHandle<R>,
    preferred: Option<&str>,
) -> Option<tauri::Monitor> {
    if let Some(name) = preferred {
        if let Ok(monitors) = app.available_monitors() {
            if let Some(m) = monitors
                .into_iter()
                .find(|m| m.name().map(|n| n.as_str()) == Some(name))
            {
                return Some(m);
            }
        }
    }
    app.primary_monitor().ok().flatten()
}

/// The monitor the island should live on, reading the persisted preference.
fn resolve_target_monitor<R: Runtime>(app: &AppHandle<R>) -> Option<tauri::Monitor> {
    resolve_monitor_named(app, load_island_config().monitor.as_deref())
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
    let sampled = raw_top_safe_inset(app, monitor);

    // Fold through the monotonic cache: a Space where the menu bar is hidden
    // may report 0 for a display that demonstrably has a notch, and trusting
    // that zero is what slid the card up under the camera housing.
    let key = monitor_cache_key(monitor);
    let Ok(mut cache) = notch_cache().lock() else {
        return sampled.max(0.0);
    };
    let folded = fold_notch_sample(cache.get(&key).copied().unwrap_or(0.0), sampled);
    cache.insert(key, folded);
    folded
}

/// The un-cached `NSScreen.safeAreaInsets.top` sample (physical px) — the raw
/// reading before [`fold_notch_sample`] makes it Space-independent. Separate so
/// the diagnostics dump can show both numbers side by side; everything else
/// should call [`monitor_top_safe_inset`].
#[cfg(target_os = "macos")]
fn raw_top_safe_inset<R: Runtime>(app: &AppHandle<R>, monitor: &tauri::Monitor) -> f64 {
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
    // One config read serves both halves of the placement: which monitor to
    // anchor to, and whether a full-screen app on it should hide the island.
    let cfg = load_island_config();
    let Some(monitor) = resolve_monitor_named(app, cfg.monitor.as_deref()) else {
        return IslandAnchor::fallback();
    };
    let scale = monitor.scale_factor();
    let work_y = monitor.work_area().position.y as f64;
    #[cfg(target_os = "macos")]
    {
        let frame = Rect {
            x: monitor.position().x as f64,
            y: monitor.position().y as f64,
            w: monitor.size().width as f64,
            h: monitor.size().height as f64,
        };
        IslandAnchor {
            x: frame.x,
            y: frame.y,
            w: frame.w,
            h: frame.h,
            scale,
            top_inset: monitor_top_safe_inset(app, &monitor),
            // `&&` on purpose, not a helper taking both values: the left side
            // must short-circuit, or the window sweep would run on every
            // geometry tick for users who never asked the island to hide.
            fullscreen: cfg.hide_on_fullscreen
                && island_space::display_is_fullscreen(frame, work_y, scale),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let rect = monitor.work_area();
        let _ = work_y;
        IslandAnchor {
            x: rect.position.x as f64,
            y: rect.position.y as f64,
            w: rect.size.width as f64,
            h: rect.size.height as f64,
            scale,
            top_inset: 0.0,
            fullscreen: false,
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
        // `None` until the first sample, so the renderer always receives an
        // initial geometry push shortly after mount even if nothing changes.
        let mut last_geometry: Option<(IslandGeometry, (f64, f64, f64))> = None;
        let mut tick: u32 = 0;
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

            // Geometry sample: catches a Space switch (enter/leave full screen),
            // a display rearrangement, and a menu-bar auto-hide toggle — none of
            // which fire any event we could listen for, and all of which used to
            // leave the strip anchored to stale numbers until the next content
            // change happened to call `island_resize`.
            if tick.is_multiple_of(GEOMETRY_SAMPLE_EVERY_TICKS) {
                let anchor = island_anchor(&app);
                let sample = (anchor.geometry(), (anchor.x, anchor.y, anchor.w));
                if last_geometry.as_ref() != Some(&sample) {
                    last_geometry = Some(sample);
                    let _ = reposition_island_with(&app, &window, anchor);
                }
            }
            tick = tick.wrapping_add(1);
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
    let _ = app.emit_to(ISLAND_LABEL, ISLAND_GEOMETRY_EVENT, anchor.geometry());
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
    reposition_island_with(app, window, island_anchor(app))
}

/// [`reposition_island`] against an anchor the caller already computed — the
/// watch loop samples one per tick and must not pay for a second full-screen
/// sweep just to apply it.
fn reposition_island_with<R: Runtime>(
    app: &AppHandle<R>,
    window: &tauri::WebviewWindow<R>,
    anchor: IslandAnchor,
) -> Result<(), String> {
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let (x, y) = resolve_island_position((anchor.x, anchor.y, anchor.w), size.width as f64);
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    emit_island_geometry(app, &anchor);
    Ok(())
}

/// Start a fresh native-panel reveal lifecycle for every island open.
///
/// `reveal_overlay_panel` deliberately rejects a generation unless its role
/// has an active open intent. Without this call the renderer's first-paint
/// reveal is a successful no-op and the late plain-`show()` fallback only
/// appears reliably while Cognia owns the foreground Space.
fn begin_island_panel_open() -> u64 {
    crate::pet_window::begin_overlay_panel_open(crate::pet_window::OverlayPanelRole::Island)
}

/// Open (or re-show) the island after atomically claiming its build lifecycle.
fn open_island_window_claimed<R: Runtime>(
    app: &AppHandle<R>,
    opts: IslandWindowOpts,
    generation: u64,
) -> Result<(), String> {
    let role = crate::pet_window::OverlayPanelRole::Island;
    if !crate::pet_window::overlay_panel_generation_is_current(role, generation) {
        return Ok(());
    }
    if let Some(window) = app.get_webview_window(ISLAND_LABEL) {
        // Recompute the top-center placement before re-showing: the monitor
        // layout / preferred monitor may have changed since the window was
        // created. Reveal through the native panel owner: ordinary
        // `WebviewWindow::show()` can remain behind another application's
        // maximized/full-screen Space.
        let _ = reposition_island(app, &window);
        if let Err(error) =
            crate::pet_window::reveal_overlay_panel(&window, role, false, generation)
        {
            crate::pet_window::cancel_overlay_panel_reveal(role);
            return Err(error);
        }
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
    // The window includes the notch strip; the renderer pads its card's
    // content below the inset (it learns the value from `island_resize`'s
    // return) while the card's body covers the strip itself.
    .inner_size(opts.width, opts.height + anchor.top_inset_logical())
    .build()
    .map_err(|error| {
        crate::pet_window::cancel_overlay_panel_reveal(role);
        error.to_string()
    })?;

    // Strip the app menu bar on Windows/Linux (same fix as the pet overlay).
    let _ = window.remove_menu();

    if let Err(error) = window.set_position(PhysicalPosition::new(x, y)) {
        crate::pet_window::cancel_overlay_panel_reveal(role);
        let _ = window.close();
        return Err(error.to_string());
    }

    // Non-activating NSPanel: float over all Spaces + full-screen apps, never
    // steal focus. `Island` role — key-capable like the popup (the inline
    // reply input must accept typing; `becomes_key_only_if_needed` keeps
    // plain clicks non-key) but at a window level ABOVE the menu bar, since
    // the strip hugs the true top edge of the screen.
    //
    // `configure_overlay_panel` schedules the raw AppKit conversion on the
    // main thread and waits for it. The open command therefore cannot report
    // success while this is still an ordinary NSWindow, nor can first-paint
    // reveal race ahead of the all-Spaces/full-screen collection behavior.
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

    spawn_hover_monitor(app);

    // Reveal is renderer-driven after first paint; force-show safety net
    // mirrors the pet window's (a hung hydrate must not strand an invisible
    // island forever).
    {
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(8)).await;
            if !crate::pet_window::overlay_panel_generation_is_current(role, generation) {
                return;
            }
            if let Some(window) = handle.get_webview_window(ISLAND_LABEL) {
                if !window.is_visible().unwrap_or(true) {
                    log::warn!(
                        "island window still hidden 8s after open; force-showing (renderer never signaled first paint)"
                    );
                    // `show()` on the native panel owner maps to
                    // `orderFrontRegardless`, which crosses another app's
                    // Space without activating Cognia or stealing focus.
                    let _ =
                        crate::pet_window::reveal_overlay_panel(&window, role, false, generation);
                }
            }
        });
    }

    Ok(())
}

/// Open (or re-show) the island. Shared by the Tauri command and the tray
/// action — idempotent like `open_pet_window_inner`.
///
/// Initial panel conversion is synchronous from this caller's perspective.
/// Serialize it with re-show requests so a newer open cannot adopt the hidden
/// window while an older generation is still configuring it, then have the
/// older generation detach and close the newer owner's live panel.
pub(crate) fn open_island_window_inner<R: Runtime>(
    app: &AppHandle<R>,
    opts: IslandWindowOpts,
) -> Result<(), String> {
    set_island_open_flag(true);
    let role = crate::pet_window::OverlayPanelRole::Island;
    let generation = begin_island_panel_open();
    if let Some(_build_guard) = crate::pet_window::try_begin_overlay_panel_build(role) {
        return open_island_window_claimed(app, opts, generation);
    }

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        for _ in 0..200 {
            if !crate::pet_window::overlay_panel_generation_is_current(role, generation) {
                return;
            }
            if let Some(_build_guard) = crate::pet_window::try_begin_overlay_panel_build(role) {
                if let Err(error) = open_island_window_claimed(&handle, opts, generation) {
                    log::error!("island: queued open failed: {error}");
                }
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        log::error!("island: timed out waiting for the window lifecycle to become idle");
    });
    Ok(())
}

pub(crate) fn close_island_window_inner<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    set_island_open_flag(false);
    crate::pet_window::cancel_overlay_panel_reveal(crate::pet_window::OverlayPanelRole::Island);
    if let Some(window) = app.get_webview_window(ISLAND_LABEL) {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Record the island's shown/hidden intent. Best-effort: failing to persist the
/// preference must never fail the window operation the user actually asked for.
fn set_island_open_flag(open: bool) {
    let mut cfg = load_island_config();
    if cfg.open == open {
        return;
    }
    cfg.open = open;
    if let Err(e) = save_island_config(&cfg) {
        log::warn!("island: persisting open={open} failed: {e}");
    }
}

/// Boot restore: reopen the island when it was showing at last quit.
///
/// Deliberately a no-op (not an error) when it was closed, so the caller can
/// fire it unconditionally alongside `fleet_monitor_restore` — the two halves of
/// "put the fleet back the way the user left it" belong on the same boot path.
#[tauri::command]
pub async fn island_restore(app: AppHandle) -> Result<bool, String> {
    if !load_island_config().open {
        return Ok(false);
    }
    open_island_window_inner(&app, IslandWindowOpts::default())?;
    Ok(true)
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

/// Reveal the island overlay after its first painted frame. Mirrors
/// `pet_window::reveal_pet_window`: non-activating NSPanel on macOS, plain
/// show elsewhere. The renderer calls this from `IslandView` mount.
#[tauri::command]
pub async fn reveal_island_window(window: WebviewWindow, focus: bool) -> Result<(), String> {
    if window.label() != ISLAND_LABEL {
        return Err(format!(
            "reveal_island_window called from window '{}', expected '{}'",
            window.label(),
            ISLAND_LABEL
        ));
    }
    let role = crate::pet_window::OverlayPanelRole::Island;
    let generation = crate::pet_window::current_overlay_panel_generation(role);
    crate::pet_window::reveal_overlay_panel(&window, role, focus, generation)
}

/// Resize on expand/collapse, keeping the strip centered under the notch.
/// `width`/`height` are the renderer-measured logical CONTENT size, clamped
/// so the strip never spills off-screen; the window grows by the display's
/// top safe-area inset.
///
/// Returns the display's full [`IslandGeometry`] rather than a bare inset, so
/// the renderer learns the notch padding AND the full-screen regime from the
/// same round-trip it already makes after every layout. The
/// `fleet://island-geometry` event carries the same payload for changes that
/// happen without a resize (Space switch, monitor change).
#[tauri::command]
pub async fn island_resize(
    app: AppHandle,
    width: f64,
    height: f64,
) -> Result<IslandGeometry, String> {
    let anchor = island_anchor(&app);
    let inset_logical = anchor.top_inset_logical();
    let Some(window) = app.get_webview_window(ISLAND_LABEL) else {
        return Ok(anchor.geometry());
    };
    let (width, height) = clamp_island_size(width, height, anchor.content_max_logical());
    window
        .set_size(tauri::LogicalSize::new(width, height + inset_logical))
        .map_err(|e| e.to_string())?;

    let (x, y) = resolve_island_position((anchor.x, anchor.y, anchor.w), width * anchor.scale);
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    Ok(anchor.geometry())
}

/// One display's raw placement inputs, for the diagnostics dump.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IslandDisplayDebug {
    pub name: Option<String>,
    pub cache_key: String,
    pub is_primary: bool,
    pub is_target: bool,
    pub scale: f64,
    /// Full display frame (physical px): x, y, width, height.
    pub frame: [f64; 4],
    /// Work area (physical px) — `NSScreen.visibleFrame` on macOS.
    pub work_area: [f64; 4],
    /// Raw `NSScreen.safeAreaInsets.top` for this sample (physical px).
    pub safe_area_top_raw: f64,
    /// The monotonic cached notch height actually used (physical px).
    pub safe_area_top_cached: f64,
    /// Free menu-bar probe: does the work area start below the frame top?
    pub menu_bar_occupies_top: bool,
    /// Full verdict, including the window sweep when the probe says hidden.
    ///
    /// Deliberately the RAW verdict, un-gated by
    /// [`IslandConfig::hide_on_fullscreen`] — a diagnostics dump exists to show
    /// what the machinery detected, and comparing this against
    /// [`IslandDebugGeometry::geometry`]'s (gated) flag is how the preference's
    /// effect is read off the dump.
    pub fullscreen: bool,
}

/// Everything the island's placement math reads, in one snapshot.
///
/// This exists because the failure mode being chased is invisible from a unit
/// test: `island_window.rs`'s live window ops can't run under
/// `tauri::test::mock_app()`, and the quantities that go wrong
/// (`safeAreaInsets` under a hidden menu bar, the Space-dependent work area)
/// are only observable on a real desktop in a real Space. Dumping them lets a
/// placement bug be diagnosed from numbers instead of screenshots.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IslandDebugGeometry {
    pub displays: Vec<IslandDisplayDebug>,
    /// Preferred monitor name from `island-window.json`, if any.
    pub preferred_monitor: Option<String>,
    /// Island window outer position (physical px), when the window exists.
    pub window_position: Option<[f64; 2]>,
    /// Island window outer size (physical px), when the window exists.
    pub window_size: Option<[f64; 2]>,
    pub window_visible: bool,
    /// The geometry currently being pushed to the renderer.
    pub geometry: IslandGeometry,
}

/// Dump every placement input for the current moment. Read-only.
#[tauri::command]
pub async fn island_debug_geometry(app: AppHandle) -> Result<IslandDebugGeometry, String> {
    let preferred = load_island_config().monitor;
    let target_key = resolve_target_monitor(&app).map(|m| monitor_cache_key(&m));
    let primary_pos = app.primary_monitor().ok().flatten().map(|m| *m.position());
    let monitors = app.available_monitors().map_err(|e| e.to_string())?;

    let displays = monitors
        .into_iter()
        .map(|m| {
            let scale = m.scale_factor();
            let frame = Rect {
                x: m.position().x as f64,
                y: m.position().y as f64,
                w: m.size().width as f64,
                h: m.size().height as f64,
            };
            let work = m.work_area();
            let work_y = work.position.y as f64;
            let cache_key = monitor_cache_key(&m);
            // `monitor_top_safe_inset` folds into the cache as a side effect, so
            // read the raw sample first to show both numbers side by side.
            #[cfg(target_os = "macos")]
            let raw = raw_top_safe_inset(&app, &m);
            #[cfg(not(target_os = "macos"))]
            let raw = 0.0;
            #[cfg(target_os = "macos")]
            let cached = monitor_top_safe_inset(&app, &m);
            #[cfg(not(target_os = "macos"))]
            let cached = 0.0;
            IslandDisplayDebug {
                name: m.name().cloned(),
                is_primary: primary_pos.as_ref() == Some(m.position()),
                is_target: target_key.as_deref() == Some(cache_key.as_str()),
                cache_key,
                scale,
                frame: [frame.x, frame.y, frame.w, frame.h],
                work_area: [
                    work.position.x as f64,
                    work_y,
                    work.size.width as f64,
                    work.size.height as f64,
                ],
                safe_area_top_raw: raw,
                safe_area_top_cached: cached,
                menu_bar_occupies_top: island_space::menu_bar_occupies_top(frame.y, work_y, scale),
                fullscreen: island_space::display_is_fullscreen(frame, work_y, scale),
            }
        })
        .collect();

    let window = app.get_webview_window(ISLAND_LABEL);
    Ok(IslandDebugGeometry {
        displays,
        preferred_monitor: preferred,
        window_position: window
            .as_ref()
            .and_then(|w| w.outer_position().ok())
            .map(|p| [p.x as f64, p.y as f64]),
        window_size: window
            .as_ref()
            .and_then(|w| w.outer_size().ok())
            .map(|s| [s.width as f64, s.height as f64]),
        window_visible: window
            .as_ref()
            .map(|w| w.is_visible().unwrap_or(false))
            .unwrap_or(false),
        geometry: island_anchor(&app).geometry(),
    })
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

/// Read the "hide while a full-screen app owns the display" preference.
///
/// Lives in `island-window.json` next to the monitor choice rather than in the
/// renderer's settings row, because the placement path that consumes it runs in
/// Rust and on the tray-toggle path never goes through a renderer at all.
#[tauri::command]
pub async fn island_get_hide_on_fullscreen() -> bool {
    load_island_config().hide_on_fullscreen
}

/// Persist the "hide while a full-screen app owns the display" preference and
/// push the new regime to a live island immediately.
///
/// Without the push the island would still correct itself — the hover monitor
/// re-samples the geometry every few hundred ms — but a preference the user just
/// flipped must take effect while they are still looking at the switch.
#[tauri::command]
pub async fn island_set_hide_on_fullscreen(app: AppHandle, hide: bool) -> Result<(), String> {
    let mut cfg = load_island_config();
    if cfg.hide_on_fullscreen != hide {
        cfg.hide_on_fullscreen = hide;
        save_island_config(&cfg)?;
    }
    if let Some(window) = app.get_webview_window(ISLAND_LABEL) {
        reposition_island(&app, &window)?;
    }
    Ok(())
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
            fullscreen: false,
        };
        assert_eq!(anchor.top_inset_logical(), 37.0);
        assert_eq!(anchor.content_max_logical(), (1512.0, 982.0 - 37.0));
        assert_eq!(
            anchor.geometry(),
            IslandGeometry {
                top_inset: 37.0,
                fullscreen: false
            }
        );
    }

    #[test]
    fn notch_sample_folds_monotonically() {
        // First observation on a notched display seeds the cache.
        assert_eq!(fold_notch_sample(0.0, 74.0), 74.0);
        // A Space that reports 0 (menu bar hidden) must NOT erase it — this is
        // the whole point of the cache and the root of the misplacement bug.
        assert_eq!(fold_notch_sample(74.0, 0.0), 74.0);
        // A larger reading wins (display swapped / scale changed).
        assert_eq!(fold_notch_sample(74.0, 80.0), 80.0);
        // Non-notched displays stay at zero forever.
        assert_eq!(fold_notch_sample(0.0, 0.0), 0.0);
        // Garbage in can't poison the cache.
        assert_eq!(fold_notch_sample(74.0, f64::NAN), 74.0);
        assert_eq!(fold_notch_sample(0.0, -5.0), 0.0);
        // A non-finite sample is rejected outright rather than folded — an
        // infinite "notch" would pin the card off the bottom of the screen
        // forever, and the cache is monotonic so it could never recover.
        assert_eq!(fold_notch_sample(74.0, f64::INFINITY), 74.0);
        assert_eq!(fold_notch_sample(0.0, f64::NEG_INFINITY), 0.0);
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
        let json = serde_json::to_string(&IslandGeometry {
            top_inset: 37.0,
            fullscreen: true,
        })
        .unwrap();
        assert_eq!(json, r#"{"topInset":37.0,"fullscreen":true}"#);
    }

    #[test]
    fn island_config_serde_roundtrip_and_defaults() {
        // Missing / unknown fields tolerate old and future config files.
        let empty: IslandConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(empty, IslandConfig::default());
        assert!(empty.monitor.is_none());

        // A config written before `open` existed restores as closed.
        let legacy: IslandConfig = serde_json::from_str(r#"{"monitor":"DELL U2723QE"}"#).unwrap();
        assert_eq!(legacy.monitor.as_deref(), Some("DELL U2723QE"));
        assert!(!legacy.open);

        let cfg = IslandConfig {
            monitor: Some("DELL U2723QE".into()),
            open: true,
            hide_on_fullscreen: true,
        };
        let json = serde_json::to_string(&cfg).unwrap();
        let back: IslandConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back, cfg);
        assert!(json.contains("hideOnFullscreen"));
    }

    /// The island must float over full-screen Spaces unless the user asked it
    /// not to. This is the whole fix: hiding there shipped unconditionally and
    /// read as "the island only works on Cognia's own desktop".
    #[test]
    fn hiding_on_fullscreen_is_off_until_the_user_opts_in() {
        assert!(!IslandConfig::default().hide_on_fullscreen);
        // Config files written before the preference existed also restore to
        // showing everywhere — no migration, the serde default carries it.
        let legacy: IslandConfig = serde_json::from_str(r#"{"monitor":null,"open":true}"#).unwrap();
        assert!(!legacy.hide_on_fullscreen);

        let opted_in: IslandConfig = serde_json::from_str(r#"{"hideOnFullscreen":true}"#).unwrap();
        assert!(opted_in.hide_on_fullscreen);
    }

    #[test]
    fn opening_the_island_arms_its_native_panel_reveal() {
        let generation = begin_island_panel_open();
        let role = crate::pet_window::OverlayPanelRole::Island;

        assert!(crate::pet_window::overlay_panel_generation_is_current(
            role, generation
        ));

        crate::pet_window::cancel_overlay_panel_reveal(role);
    }

    #[test]
    fn island_panel_builds_are_serialized() {
        let role = crate::pet_window::OverlayPanelRole::Island;
        let first = crate::pet_window::try_begin_overlay_panel_build(role)
            .expect("first island build should claim the lifecycle");

        assert!(crate::pet_window::try_begin_overlay_panel_build(role).is_none());

        drop(first);
        assert!(crate::pet_window::try_begin_overlay_panel_build(role).is_some());
    }

    #[test]
    fn closing_cancels_an_island_open_waiting_for_the_build_guard() {
        let role = crate::pet_window::OverlayPanelRole::Island;
        let first = crate::pet_window::try_begin_overlay_panel_build(role)
            .expect("first island build should claim the lifecycle");
        let queued_generation = begin_island_panel_open();

        crate::pet_window::cancel_overlay_panel_reveal(role);
        drop(first);

        assert!(!crate::pet_window::overlay_panel_generation_is_current(
            role,
            queued_generation
        ));
        assert!(crate::pet_window::try_begin_overlay_panel_build(role).is_some());
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
