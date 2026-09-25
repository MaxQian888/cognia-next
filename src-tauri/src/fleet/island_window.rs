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
//! ## Units (macOS)
//!
//! Every placement is applied in LOGICAL px on macOS. tao converts a
//! `Physical*` value with the window's CURRENT backing scale, not the target
//! display's, so a physical frame computed for a 1x external display landed
//! at half its coordinates (and half its size) while the window still sat on
//! the 2x notched panel. tao also resizes through `-setContentSize:`, which
//! keeps the frame's bottom-left corner fixed: resizing after positioning let
//! the top edge drift off the top of the screen, taking the card with it. The
//! size is therefore applied first and the top-left pinned after it. The
//! cursor hit test is logical for the same reason — tao scales the cursor by
//! the PRIMARY display and the window frame by its own. Windows keeps physical
//! coordinates, in the old order (position, then size): its monitor and window
//! spaces are physical, and a cross-DPI move rescales the window itself. Linux
//! shares that path; its GDK model is logical like macOS, but X11 applies one
//! scale to every monitor and Wayland cannot position windows at all, so the
//! physical path is exact there in practice.
//!
//! Live window ops can't run under `tauri::test::mock_app()` on this
//! project's toolchains (same constraint documented in `pet_window/mod.rs`),
//! so only the pure placement math is unit-tested; the runtime behavior is
//! covered by `tauri-smoke`.

use crate::fleet::island_space::{self, Rect};
use crate::fs_atomic::{atomic_write_with_mtime_check, rotate_backups, AtomicWritePlan};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewWindow};

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

/// Per-display notch metrics (physical px), keyed by [`monitor_cache_key`].
///
/// A display's camera housing is a **physical property** — it does not come and
/// go with the menu bar. `NSScreen.safeAreaInsets.top`, however, is queried
/// against the current Space, and Apple documents no guarantee that it keeps
/// reporting the housing once the menu bar is hidden. Caching the largest value
/// ever observed per display makes the island's notch padding Space-independent
/// no matter which way that API behaves, which is the other half of the fix
/// begun when the anchor moved off `work_area` (see the module docs).
static NOTCH_CACHE: OnceLock<Mutex<HashMap<String, NotchMetrics>>> = OnceLock::new();

fn notch_cache() -> &'static Mutex<HashMap<String, NotchMetrics>> {
    NOTCH_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The camera housing as one display reports it, in physical px: its height
/// (`NSScreen.safeAreaInsets.top`) and its width (the frame minus the two
/// `auxiliaryTop*Area` rects beside it). Both are 0 on a display without one.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub(crate) struct NotchMetrics {
    pub inset: f64,
    pub width: f64,
}

/// Fold a fresh `safeAreaInsets.top` sample into the cached value: monotonic,
/// never negative. Pure for unit tests.
pub(crate) fn fold_notch_sample(cached: f64, sampled: f64) -> f64 {
    let sampled = if sampled.is_finite() { sampled } else { 0.0 };
    cached.max(sampled).max(0.0)
}

/// [`fold_notch_sample`] over both metrics. The width folds the same way as
/// the height and for the same reason: the housing is a physical property, and
/// a Space that hides the menu bar may report neither.
pub(crate) fn fold_notch_metrics(cached: NotchMetrics, sampled: NotchMetrics) -> NotchMetrics {
    NotchMetrics {
        inset: fold_notch_sample(cached.inset, sampled.inset),
        width: fold_notch_sample(cached.width, sampled.width),
    }
}

/// Stable identity for physical notch metrics. Include scale so changing a
/// display's scaling cannot reuse a larger physical inset from its old mode.
/// Prefer the display name, else use its geometry to distinguish displays.
fn monitor_cache_key(monitor: &tauri::Monitor) -> String {
    if let Some(name) = monitor.name() {
        if !name.is_empty() {
            return format!("{name} @{}", monitor.scale_factor());
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
    /// Width (logical px) of the camera housing itself, so the renderer can
    /// draw its compact presentation as ears either side of the camera inside
    /// the menu-bar strip. 0 when the display has no housing, or when the OS
    /// could not report the auxiliary areas — the renderer then falls back to
    /// its flat pill, padded below the inset.
    pub notch_width: f64,
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

/// The last config read from, or written to, `island-window.json`.
///
/// Every placement reads the config, and the hover loop places the window on a
/// geometry tick about twice a second, so reading the file each time was a
/// disk read and a JSON parse per tick for the life of the app. The file is
/// only written through [`update_island_config`], which refreshes this, so
/// the cache cannot go stale behind the app's back (a hand edit while the app
/// runs is picked up on the next launch).
static ISLAND_CONFIG_CACHE: Mutex<Option<IslandConfig>> = Mutex::new(None);

fn load_island_config() -> IslandConfig {
    if let Ok(cache) = ISLAND_CONFIG_CACHE.lock() {
        if let Some(cfg) = cache.as_ref() {
            return cfg.clone();
        }
    }
    let cfg = island_config_path()
        .and_then(|path| read_island_config(&path).ok())
        .unwrap_or_default();
    if let Ok(mut cache) = ISLAND_CONFIG_CACHE.lock() {
        *cache = Some(cfg.clone());
    }
    cfg
}

fn read_island_config(path: &Path) -> Result<IslandConfig, String> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| error.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(IslandConfig::default()),
        Err(error) => Err(error.to_string()),
    }
}

// Tray and async IPC writers share the entire read-modify-publish transaction.
// Readers need no lock because publication is an atomic rename.
static ISLAND_CONFIG_WRITE_LOCK: Mutex<()> = Mutex::new(());

fn update_island_config(update: impl FnOnce(&mut IslandConfig)) -> Result<(), String> {
    let path = island_config_path().ok_or_else(|| "cannot resolve cognia home".to_string())?;
    let _guard = ISLAND_CONFIG_WRITE_LOCK
        .lock()
        .map_err(|error| error.to_string())?;
    let cfg = update_island_config_locked(&path, update)?;
    // Refreshed under the write lock, after the publish: writers land in lock
    // order, so the cache always ends on the config that is on disk, and a
    // failed write leaves it untouched.
    if let Ok(mut cache) = ISLAND_CONFIG_CACHE.lock() {
        *cache = Some(cfg);
    }
    Ok(())
}

#[cfg(test)]
fn update_island_config_at(
    path: &Path,
    update: impl FnOnce(&mut IslandConfig),
) -> Result<(), String> {
    let _guard = ISLAND_CONFIG_WRITE_LOCK
        .lock()
        .map_err(|error| error.to_string())?;
    update_island_config_locked(path, update).map(|_| ())
}

/// Read-modify-publish `path`, returning the config now on disk. The caller
/// holds [`ISLAND_CONFIG_WRITE_LOCK`] for the whole transaction.
fn update_island_config_locked(
    path: &Path,
    update: impl FnOnce(&mut IslandConfig),
) -> Result<IslandConfig, String> {
    let expected_mtime = std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok();
    let mut cfg = read_island_config(path)?;
    let previous = cfg.clone();
    update(&mut cfg);
    if cfg == previous {
        return Ok(cfg);
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_vec_pretty(&cfg).map_err(|e| e.to_string())?;
    atomic_write_with_mtime_check(
        &AtomicWritePlan {
            path: path.to_path_buf(),
            expected_mtime,
            tmp_suffix: "tmp".into(),
            backup_suffix: "bak".into(),
        },
        &json,
    )
    .map_err(|error| error.to_string())?;
    rotate_backups(path, 1);
    Ok(cfg)
}

/// Collapsed pill footprint (logical px) used when the renderer passes no
/// explicit size. The renderer resizes via `island_resize` on expand/collapse.
const DEFAULT_ISLAND_WIDTH: f64 = 420.0;
const DEFAULT_ISLAND_HEIGHT: f64 = 44.0;

// Keep the renderer's logical request, rather than the last clamped native
// size: returning to a larger display must restore the full content footprint.
static ISLAND_CONTENT_SIZE: Mutex<(f64, f64)> =
    Mutex::new((DEFAULT_ISLAND_WIDTH, DEFAULT_ISLAND_HEIGHT));

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
    /// Camera-housing width (physical px); 0 when there is none or unknown.
    notch_width: f64,
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
            notch_width: 0.0,
            fullscreen: false,
        }
    }

    fn geometry(&self) -> IslandGeometry {
        IslandGeometry {
            top_inset: self.top_inset_logical(),
            notch_width: self.notch_width / self.scale(),
            fullscreen: self.fullscreen,
        }
    }

    /// Backing scale, never zero: a display that reports no scale is 1x.
    fn scale(&self) -> f64 {
        if self.scale > 0.0 {
            self.scale
        } else {
            1.0
        }
    }

    fn top_inset_logical(&self) -> f64 {
        self.top_inset / self.scale()
    }
}

/// The island window's target frame in LOGICAL px, in global top-left-origin
/// coordinates. macOS places it as is — the only unit tao converts correctly
/// when the target display is not the one the window is on (see the module
/// docs); Windows and Linux convert it to the target display's physical px
/// ([`island_physical_frame`]).
#[derive(Debug, Clone, Copy, PartialEq)]
struct IslandFrame {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

/// Top-center frame for the renderer's requested logical CONTENT size.
///
/// The window always hugs the anchor top and grows by the display's notch
/// inset: on macOS the housing strip lives INSIDE the window, so the strip
/// level with the camera housing still catches slam-to-top hover, and the
/// renderer paints its compact presentation there. The content is clamped to
/// the area below the inset so an expanded island can never spill past the
/// screen. A content height of 0 is legitimate — on a notched display the
/// compact island lives entirely in the housing strip — so only the whole
/// window is kept at least 1 px tall. Pure for unit tests.
fn island_frame(anchor: IslandAnchor, requested: (f64, f64)) -> IslandFrame {
    let scale = anchor.scale();
    let inset = anchor.top_inset_logical();
    let area_x = anchor.x / scale;
    let area_w = anchor.w / scale;
    let content_max = (anchor.h / scale - inset).max(0.0);
    // `f64::min` returns the other operand for NaN, so a garbage request is
    // clamped to the area rather than propagated.
    let w = requested.0.min(area_w).max(1.0);
    let content_h = requested.1.min(content_max).max(0.0);
    IslandFrame {
        x: (area_x + (area_w - w) / 2.0).max(area_x),
        y: anchor.y / scale,
        w,
        h: (content_h + inset).max(1.0),
    }
}

/// [`island_frame`] in the anchor display's physical px, for the platforms
/// whose window space is physical. Size is rounded first and the position is
/// centred on the rounded width, so the strip never straddles a pixel.
#[cfg(any(not(target_os = "macos"), test))]
fn island_physical_frame(anchor: IslandAnchor, frame: IslandFrame) -> (f64, f64, u32, u32) {
    let scale = anchor.scale();
    let width = (frame.w * scale).round().max(1.0);
    let height = (frame.h * scale).round().max(1.0);
    let x = (anchor.x + (anchor.w - width) / 2.0).max(anchor.x);
    (x, anchor.y, width as u32, height as u32)
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
    monitor_notch_metrics(app, monitor).inset
}

/// Both housing metrics (physical px), folded through the monotonic cache: a
/// Space where the menu bar is hidden may report 0 for a display that
/// demonstrably has a notch, and trusting that zero is what slid the card up
/// under the camera housing.
#[cfg(target_os = "macos")]
fn monitor_notch_metrics<R: Runtime>(app: &AppHandle<R>, monitor: &tauri::Monitor) -> NotchMetrics {
    let sampled = raw_notch_metrics(app, monitor);

    let key = monitor_cache_key(monitor);
    let Ok(mut cache) = notch_cache().lock() else {
        return fold_notch_metrics(NotchMetrics::default(), sampled);
    };
    let folded = fold_notch_metrics(cache.get(&key).copied().unwrap_or_default(), sampled);
    cache.insert(key, folded);
    folded
}

/// The un-cached `NSScreen.safeAreaInsets.top` sample (physical px) — the raw
/// reading before [`fold_notch_sample`] makes it Space-independent. Separate so
/// the diagnostics dump can show both numbers side by side; everything else
/// should call [`monitor_top_safe_inset`].
#[cfg(target_os = "macos")]
fn raw_top_safe_inset<R: Runtime>(app: &AppHandle<R>, monitor: &tauri::Monitor) -> f64 {
    raw_notch_metrics(app, monitor).inset
}

/// Housing width from the auxiliary areas Apple exposes beside it: the frame
/// minus the top-left and top-right rects. Only meaningful with a non-zero
/// inset; a display that reports either rect empty yields 0 (unknown), which
/// the renderer treats as "paint the whole strip", the pre-existing look.
pub(crate) fn notch_width_from_aux(
    frame_width: f64,
    inset: f64,
    left_width: f64,
    right_width: f64,
) -> f64 {
    if inset <= 0.0 || left_width <= 0.0 || right_width <= 0.0 {
        return 0.0;
    }
    let width = frame_width - left_width - right_width;
    if width.is_finite() && width > 0.0 {
        width
    } else {
        0.0
    }
}

/// The un-cached housing sample (physical px) for the screen backing
/// `monitor`; see [`raw_top_safe_inset`] for the screen matching.
#[cfg(target_os = "macos")]
fn raw_notch_metrics<R: Runtime>(app: &AppHandle<R>, monitor: &tauri::Monitor) -> NotchMetrics {
    use objc2::MainThreadMarker;

    let scale = monitor.scale_factor();
    if scale <= 0.0 {
        return NotchMetrics::default();
    }
    let logical_x = monitor.position().x as f64 / scale;
    let logical_y = monitor.position().y as f64 / scale;
    let logical_w = monitor.size().width as f64 / scale;
    let logical_h = monitor.size().height as f64 / scale;

    let compute = move || -> NotchMetrics {
        let Some(mtm) = MainThreadMarker::new() else {
            return NotchMetrics::default();
        };
        let screens = objc2_app_kit::NSScreen::screens(mtm);
        let Some(primary) = screens.iter().next() else {
            return NotchMetrics::default();
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
                let inset = screen.safeAreaInsets().top.max(0.0);
                let width = notch_width_from_aux(
                    frame.size.width,
                    inset,
                    screen.auxiliaryTopLeftArea().size.width,
                    screen.auxiliaryTopRightArea().size.width,
                );
                return NotchMetrics {
                    inset: inset * scale,
                    width: width * scale,
                };
            }
        }
        NotchMetrics::default()
    };

    appkit_query(app, compute).unwrap_or_default()
}

/// Run an AppKit query on the main thread and wait for its answer.
///
/// NSScreen and friends are main-thread-only. Every placement path here can
/// run on a tokio worker (async commands, the hover loop), so the query is
/// bridged through `run_on_main_thread` with a fail-open timeout — never a
/// deadlock risk, because off-main implies the main loop is free. `None` when
/// the bridge failed or timed out.
#[cfg(target_os = "macos")]
fn appkit_query<R: Runtime, T: Send + 'static>(
    app: &AppHandle<R>,
    compute: impl FnOnce() -> T + Send + 'static,
) -> Option<T> {
    if objc2::MainThreadMarker::new().is_some() {
        return Some(compute());
    }
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(compute());
    })
    .ok()?;
    rx.recv_timeout(std::time::Duration::from_millis(500)).ok()
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
        let notch = monitor_notch_metrics(app, &monitor);
        IslandAnchor {
            x: frame.x,
            y: frame.y,
            w: frame.w,
            h: frame.h,
            scale,
            top_inset: notch.inset,
            notch_width: notch.width,
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
            notch_width: 0.0,
            fullscreen: false,
        }
    }
}

/// Whether a global cursor point sits inside a window rect, all in one space
/// (logical px, as [`cursor_hits_window`] passes them). Pure for unit tests.
fn point_in_rect(point: (f64, f64), origin: (f64, f64), size: (f64, f64)) -> bool {
    point.0 >= origin.0
        && point.0 < origin.0 + size.0
        && point.1 >= origin.1
        && point.1 < origin.1 + size.1
}

/// Whether a cursor sample lands on a window, each expressed in its own
/// physical space: the cursor scaled by `cursor_scale`, the window frame by
/// `window_scale`. Both are divided back to logical px before comparing, so
/// the two spaces only have to agree on logical coordinates. Pure for unit
/// tests.
fn cursor_hits_window(
    cursor: (f64, f64),
    cursor_scale: f64,
    origin: (f64, f64),
    size: (f64, f64),
    window_scale: f64,
) -> bool {
    let cursor_scale = if cursor_scale > 0.0 {
        cursor_scale
    } else {
        1.0
    };
    let window_scale = if window_scale > 0.0 {
        window_scale
    } else {
        1.0
    };
    point_in_rect(
        (cursor.0 / cursor_scale, cursor.1 / cursor_scale),
        (origin.0 / window_scale, origin.1 / window_scale),
        (size.0 / window_scale, size.1 / window_scale),
    )
}

/// The scale tao applied to the cursor position it reports. On macOS that is
/// the PRIMARY display's backing scale (`CGMainDisplayID`, the screen with the
/// menu bar, `NSScreen.screens[0]`) whatever display the cursor is on, while
/// the window frame is scaled by the window's own display; elsewhere both are
/// the same space and no rescale is needed. Read through AppKit on the main
/// thread: `AppHandle::primary_monitor` would enumerate NSScreen on the
/// calling tokio worker.
fn cursor_space_scale<R: Runtime>(app: &AppHandle<R>) -> f64 {
    #[cfg(target_os = "macos")]
    {
        appkit_query(app, || {
            let mtm = objc2::MainThreadMarker::new()?;
            let screens = objc2_app_kit::NSScreen::screens(mtm);
            let primary = screens.iter().next()?;
            Some(primary.backingScaleFactor())
        })
        .flatten()
        .unwrap_or(1.0)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        1.0
    }
}

/// The scale tao applied to the window frame it reports; see
/// [`cursor_space_scale`].
fn window_space_scale<R: Runtime>(window: &tauri::WebviewWindow<R>) -> f64 {
    #[cfg(target_os = "macos")]
    {
        window.scale_factor().unwrap_or(1.0)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        1.0
    }
}

/// Is the global cursor currently over the island window? `false` on any
/// query failure (treat unknown as "not hovering" so a broken query can only
/// tuck the island, never pin it). `cursor_scale` comes from
/// [`cursor_space_scale`], sampled by the caller at geometry cadence rather
/// than on every hover tick.
fn cursor_inside_island<R: Runtime>(window: &tauri::WebviewWindow<R>, cursor_scale: f64) -> bool {
    let (Ok(cursor), Ok(pos), Ok(size)) = (
        window.cursor_position(),
        window.outer_position(),
        window.outer_size(),
    ) else {
        return false;
    };
    cursor_hits_window(
        (cursor.x, cursor.y),
        cursor_scale,
        (pos.x as f64, pos.y as f64),
        (size.width as f64, size.height as f64),
        window_space_scale(window),
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
        let mut last_geometry: Option<IslandAnchor> = None;
        let mut cursor_scale = cursor_space_scale(&app);
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
            let inside = cursor_inside_island(&window, cursor_scale);
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
                // A display rearrangement can change which display is primary,
                // and with it the cursor's scale.
                cursor_scale = cursor_space_scale(&app);
                let anchor = island_anchor(&app);
                if last_geometry != Some(anchor)
                    && reposition_island_with(&app, &window, anchor).is_ok()
                {
                    last_geometry = Some(anchor);
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

/// Recompute size and top-center placement from the CURRENT preferred monitor
/// and retained logical content request. Shared by re-show and the
/// set-monitor command, so every path lands the strip in the same spot; both
/// also notify the renderer (the notch inset may have changed with the
/// monitor, and the renderer answers with a fresh `island_resize`).
fn reposition_island<R: Runtime>(
    app: &AppHandle<R>,
    window: &tauri::WebviewWindow<R>,
) -> Result<(), String> {
    reposition_island_with(app, window, island_anchor(app))
}

/// Whether two content requests are the same one. Bitwise, so a NaN request
/// (which [`island_frame`] clamps) compares equal to itself. Pure for unit
/// tests.
fn same_request(a: (f64, f64), b: (f64, f64)) -> bool {
    a.0.to_bits() == b.0.to_bits() && a.1.to_bits() == b.1.to_bits()
}

/// [`reposition_island`] against an anchor the caller already computed — the
/// watch loop samples one per tick and must not pay for a second full-screen
/// sweep just to apply it.
fn reposition_island_with<R: Runtime>(
    app: &AppHandle<R>,
    window: &tauri::WebviewWindow<R>,
    anchor: IslandAnchor,
) -> Result<(), String> {
    // Never held across the apply. On Windows/Linux the apply reads the window
    // size, a blocking round trip to the main thread when this runs on a tokio
    // worker, while the tray's open path takes this lock ON the main thread:
    // holding it there could deadlock the two. Instead, a placement that read a
    // request `island_resize` has since replaced applies again with the new
    // one, so the last request still wins. Bounded, in case the renderer keeps
    // resizing faster than a frame lands.
    let read_request = || {
        ISLAND_CONTENT_SIZE
            .lock()
            .map(|size| *size)
            .map_err(|error| error.to_string())
    };
    let mut requested = read_request()?;
    for _ in 0..3 {
        apply_island_frame(window, anchor, island_frame(anchor, requested))?;
        let latest = read_request()?;
        if same_request(latest, requested) {
            break;
        }
        requested = latest;
    }
    emit_island_geometry(app, &anchor);
    Ok(())
}

/// Move and size the window to `frame`.
///
/// macOS: logical units, size FIRST. tao resizes with `-setContentSize:`,
/// which keeps the bottom-left corner fixed, so a resize after the move would
/// push the top edge off the top of the screen; pinning the top-left last
/// undoes that drift. Logical units because tao converts physical ones with
/// the window's current display scale rather than the target's.
///
/// The size is applied unconditionally. tao queues the resize on the main
/// dispatch queue while size getters answer from the event loop, so a
/// "skip if unchanged" read could see the size from before a still-queued
/// resize and leave the window at that size. Setting an unchanged content size
/// is a no-op in AppKit, and skipping the read saves two blocking round trips.
#[cfg(target_os = "macos")]
fn apply_island_frame<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    _anchor: IslandAnchor,
    frame: IslandFrame,
) -> Result<(), String> {
    window
        .set_size(tauri::LogicalSize::new(frame.w, frame.h))
        .map_err(|error| error.to_string())?;
    window
        .set_position(tauri::LogicalPosition::new(frame.x, frame.y))
        .map_err(|error| error.to_string())
}

/// Windows / Linux: physical units, position FIRST. Their window space is
/// physical, and moving across a DPI boundary rescales the window, so the
/// target display's footprint is applied after the move or the old display's
/// scale would enlarge it beyond the new area.
#[cfg(not(target_os = "macos"))]
fn apply_island_frame<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    anchor: IslandAnchor,
    frame: IslandFrame,
) -> Result<(), String> {
    let (x, y, width, height) = island_physical_frame(anchor, frame);
    window
        .set_position(tauri::PhysicalPosition::new(x, y))
        .map_err(|error| error.to_string())?;
    let size = tauri::PhysicalSize::new(width, height);
    if window.inner_size().map_err(|error| error.to_string())? != size {
        window.set_size(size).map_err(|error| error.to_string())?;
    }
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
    *ISLAND_CONTENT_SIZE
        .lock()
        .map_err(|error| error.to_string())? = (opts.width, opts.height);
    let frame = island_frame(anchor, (opts.width, opts.height));

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
    .inner_size(frame.w, frame.h)
    .build()
    .map_err(|error| {
        crate::pet_window::cancel_overlay_panel_reveal(role);
        error.to_string()
    })?;

    // Strip the app menu bar on Windows/Linux (same fix as the pet overlay).
    let _ = window.remove_menu();

    if let Err(error) = reposition_island_with(app, &window, anchor) {
        crate::pet_window::cancel_overlay_panel_reveal(role);
        let _ = window.close();
        return Err(error);
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
    if let Err(e) = update_island_config(|cfg| cfg.open = open) {
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
    let Some(window) = app.get_webview_window(ISLAND_LABEL) else {
        return Ok(anchor.geometry());
    };
    *ISLAND_CONTENT_SIZE
        .lock()
        .map_err(|error| error.to_string())? = (width, height);
    reposition_island_with(&app, &window, anchor)?;
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
    /// Backing scale the two numbers above were converted with — the
    /// window's CURRENT display, which is not necessarily the target's.
    pub window_scale: Option<f64>,
    /// Where placement wants the window: x, y, width, height in logical px
    /// (global, top-left origin), for the retained content request.
    pub target_frame: [f64; 4],
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
    let anchor = island_anchor(&app);
    let requested = *ISLAND_CONTENT_SIZE
        .lock()
        .map_err(|error| error.to_string())?;
    let target = island_frame(anchor, requested);
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
        window_scale: window.as_ref().and_then(|w| w.scale_factor().ok()),
        target_frame: [target.x, target.y, target.w, target.h],
        window_visible: window
            .as_ref()
            .map(|w| w.is_visible().unwrap_or(false))
            .unwrap_or(false),
        geometry: anchor.geometry(),
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
    update_island_config(|cfg| cfg.hide_on_fullscreen = hide)?;
    if let Some(window) = app.get_webview_window(ISLAND_LABEL) {
        reposition_island(&app, &window)?;
    }
    Ok(())
}

/// Persist the preferred monitor (`None` → follow the primary) and move a
/// live island there immediately.
#[tauri::command]
pub async fn island_set_monitor(app: AppHandle, monitor: Option<String>) -> Result<(), String> {
    update_island_config(|cfg| cfg.monitor = monitor)?;
    if let Some(window) = app.get_webview_window(ISLAND_LABEL) {
        reposition_island(&app, &window)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concurrent_config_mutations_preserve_each_preference() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("island-window.json");
        let barrier = std::sync::Barrier::new(3);
        std::thread::scope(|scope| {
            for field in 0..3 {
                let path = &path;
                let barrier = &barrier;
                scope.spawn(move || {
                    barrier.wait();
                    update_island_config_at(path, |cfg| {
                        // Overlap each writer's read-modify-write interval.
                        std::thread::sleep(std::time::Duration::from_millis(5));
                        match field {
                            0 => cfg.open = true,
                            1 => cfg.monitor = Some("External".into()),
                            _ => cfg.hide_on_fullscreen = true,
                        }
                    })
                    .unwrap();
                });
            }
        });
        assert_eq!(
            read_island_config(&path).unwrap(),
            IslandConfig {
                open: true,
                monitor: Some("External".into()),
                hide_on_fullscreen: true,
            }
        );
    }

    #[test]
    fn invalid_existing_config_is_preserved_instead_of_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("island-window.json");
        std::fs::write(&path, "invalid JSON").unwrap();
        assert!(update_island_config_at(&path, |cfg| cfg.open = true).is_err());
        assert_eq!(std::fs::read_to_string(path).unwrap(), "invalid JSON");
    }

    #[test]
    fn failed_atomic_publish_keeps_the_previous_config_readable() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("island-window.json");
        update_island_config_at(&path, |cfg| cfg.open = true).unwrap();
        std::fs::create_dir(path.with_extension("json.tmp")).unwrap();
        assert!(update_island_config_at(&path, |cfg| cfg.open = false).is_err());
        assert!(read_island_config(&path).unwrap().open);
    }

    #[test]
    fn unchanged_config_does_not_write_and_backups_are_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/island-window.json");
        update_island_config_at(&path, |cfg| cfg.open = false).unwrap();
        assert!(!path.exists());
        for open in [true, false, true, false] {
            update_island_config_at(&path, |cfg| cfg.open = open).unwrap();
        }
        assert_eq!(
            std::fs::read_dir(path.parent().unwrap()).unwrap().count(),
            2
        );
        assert_eq!(read_island_config(&path).unwrap(), IslandConfig::default());
    }

    #[test]
    fn a_replaced_content_request_is_detected_and_nan_settles() {
        assert!(same_request((420.0, 44.0), (420.0, 44.0)));
        assert!(!same_request((420.0, 44.0), (420.0, 120.0)));
        assert!(!same_request((420.0, 44.0), (380.0, 44.0)));
        // A garbage request must not keep the re-apply loop spinning.
        assert!(same_request((f64::NAN, 44.0), (f64::NAN, 44.0)));
    }

    #[test]
    fn geometry_change_detection_includes_height_and_scale() {
        let original = IslandAnchor::fallback();
        assert_ne!(
            original,
            IslandAnchor {
                h: 720.0,
                ..original
            }
        );
        assert_ne!(
            original,
            IslandAnchor {
                scale: 2.0,
                ..original
            }
        );
    }

    /// A 14" MacBook Pro: 1512x982 logical at 2x with a 37-pt housing strip.
    fn retina_notched() -> IslandAnchor {
        IslandAnchor {
            x: 0.0,
            y: 0.0,
            w: 3024.0,
            h: 1964.0,
            scale: 2.0,
            top_inset: 74.0,
            notch_width: 400.0,
            fullscreen: false,
        }
    }

    #[test]
    fn frame_clamps_to_a_shorter_display_and_restores_the_request() {
        let requested = (560.0, 900.0);
        let large = IslandAnchor::fallback();
        let short = IslandAnchor { h: 600.0, ..large };
        assert_eq!(island_frame(large, requested).h, 900.0);
        assert_eq!(island_frame(short, requested).h, 600.0);
        // The request is retained, so returning to the larger display grows back.
        assert_eq!(island_frame(large, requested).h, 900.0);
    }

    #[test]
    fn frame_is_logical_and_grows_by_the_notch_strip() {
        let frame = island_frame(retina_notched(), (560.0, 300.0));
        assert_eq!(
            frame,
            IslandFrame {
                x: (1512.0 - 560.0) / 2.0,
                y: 0.0,
                w: 560.0,
                h: 337.0,
            }
        );
        // Oversized requests stop at the display, content below the strip.
        let huge = island_frame(retina_notched(), (4000.0, 4000.0));
        assert_eq!((huge.w, huge.h), (1512.0, 982.0));
    }

    #[test]
    fn zero_content_height_is_exactly_the_housing_strip() {
        // The compact island on a notched display lives inside the strip.
        let frame = island_frame(retina_notched(), (420.0, 0.0));
        assert_eq!((frame.w, frame.h), (420.0, 37.0));
        // Without a strip the window still never collapses to nothing.
        assert_eq!(island_frame(IslandAnchor::fallback(), (420.0, 0.0)).h, 1.0);
    }

    #[test]
    fn degenerate_requests_cannot_produce_an_empty_or_invalid_frame() {
        let anchor = IslandAnchor::fallback();
        let frame = island_frame(anchor, (0.0, -5.0));
        assert_eq!((frame.w, frame.h), (1.0, 1.0));
        let frame = island_frame(anchor, (f64::NAN, f64::NAN));
        assert!(frame.w.is_finite() && frame.h.is_finite());
        // A display reporting no scale is treated as 1x rather than dividing by 0.
        let unscaled = IslandAnchor {
            scale: 0.0,
            ..anchor
        };
        assert_eq!(island_frame(unscaled, (420.0, 44.0)).w, 420.0);
    }

    #[test]
    fn frame_centers_on_the_display_and_hugs_its_top() {
        // 1x display 1920 wide, 420 strip: x = (1920-420)/2, y = frame top.
        let frame = island_frame(IslandAnchor::fallback(), (420.0, 44.0));
        assert_eq!((frame.x, frame.y), (750.0, 0.0));
    }

    #[test]
    fn a_secondary_display_is_placed_in_its_own_logical_space() {
        // External 1x display to the right of a 1512-pt-wide 2x panel. tao
        // reports its origin as logical x scaled by ITS scale (1512 * 1).
        let external = IslandAnchor {
            x: 1512.0,
            y: 0.0,
            w: 2560.0,
            h: 1440.0,
            scale: 1.0,
            ..IslandAnchor::fallback()
        };
        let frame = island_frame(external, (420.0, 44.0));
        assert_eq!((frame.x, frame.y), (1512.0 + (2560.0 - 420.0) / 2.0, 0.0));
        // And a 2x display offset by 1920 physical (960 logical) px.
        let retina = IslandAnchor {
            x: 1920.0,
            y: 100.0,
            ..retina_notched()
        };
        let frame = island_frame(retina, (420.0, 0.0));
        assert_eq!((frame.x, frame.y), (960.0 + (1512.0 - 420.0) / 2.0, 50.0));
    }

    #[test]
    fn an_oversized_strip_pins_to_the_display_left() {
        let narrow = IslandAnchor {
            w: 400.0,
            ..IslandAnchor::fallback()
        };
        let frame = island_frame(narrow, (800.0, 44.0));
        assert_eq!((frame.x, frame.w), (0.0, 400.0));
    }

    #[test]
    fn physical_frame_rounds_the_size_and_centers_on_it() {
        let anchor = IslandAnchor {
            x: 100.0,
            y: 50.0,
            w: 3456.0,
            h: 2234.0,
            scale: 2.0,
            ..IslandAnchor::fallback()
        };
        let frame = island_frame(anchor, (420.25, 44.0));
        let (x, y, width, height) = island_physical_frame(anchor, frame);
        assert_eq!((width, height), (841, 88));
        assert_eq!((x, y), (100.0 + (3456.0 - 841.0) / 2.0, 50.0));
    }

    #[test]
    fn anchor_inset_conversions_are_logical() {
        let anchor = retina_notched();
        assert_eq!(anchor.top_inset_logical(), 37.0);
        assert_eq!(
            anchor.geometry(),
            IslandGeometry {
                top_inset: 37.0,
                notch_width: 200.0,
                fullscreen: false
            }
        );
    }

    #[test]
    fn cursor_and_window_are_compared_in_logical_space() {
        // macOS: the cursor is scaled by the PRIMARY display (2x built-in
        // panel), the window by its own (1x external). Logical (1600, 10) is
        // inside a window at logical x 1512..1932.
        assert!(cursor_hits_window(
            (3200.0, 20.0),
            2.0,
            (1512.0, 0.0),
            (420.0, 44.0),
            1.0
        ));
        // Comparing the raw physical numbers would have missed it entirely.
        assert!(!point_in_rect((3200.0, 20.0), (1512.0, 0.0), (420.0, 44.0)));
        // Equal scales reduce to a plain rect test, edges half-open.
        assert!(cursor_hits_window(
            (100.0, 0.0),
            2.0,
            (100.0, 0.0),
            (840.0, 88.0),
            2.0
        ));
        assert!(!cursor_hits_window(
            (940.0, 10.0),
            2.0,
            (100.0, 0.0),
            (840.0, 88.0),
            2.0
        ));
        // A zero scale cannot divide by zero.
        assert!(cursor_hits_window(
            (10.0, 10.0),
            0.0,
            (0.0, 0.0),
            (20.0, 20.0),
            0.0
        ));
    }

    #[test]
    fn notch_width_comes_from_the_auxiliary_areas() {
        // 14" MacBook Pro: 1512 logical wide, ~656 per side beside the housing.
        assert_eq!(notch_width_from_aux(1512.0, 32.0, 656.0, 656.0), 200.0);
        // No inset means no housing, whatever the rects say.
        assert_eq!(notch_width_from_aux(1512.0, 0.0, 656.0, 656.0), 0.0);
        // An empty auxiliary rect means the OS did not report it: unknown.
        assert_eq!(notch_width_from_aux(1512.0, 32.0, 0.0, 656.0), 0.0);
        assert_eq!(notch_width_from_aux(1512.0, 32.0, 656.0, 0.0), 0.0);
        // Nonsense never yields a negative or infinite width.
        assert_eq!(notch_width_from_aux(100.0, 32.0, 656.0, 656.0), 0.0);
        assert_eq!(notch_width_from_aux(f64::NAN, 32.0, 656.0, 656.0), 0.0);
    }

    #[test]
    fn notch_metrics_fold_both_fields_monotonically() {
        let seeded = fold_notch_metrics(
            NotchMetrics::default(),
            NotchMetrics {
                inset: 74.0,
                width: 400.0,
            },
        );
        assert_eq!(
            seeded,
            NotchMetrics {
                inset: 74.0,
                width: 400.0
            }
        );
        // A menu-bar-hidden Space reporting nothing keeps both.
        assert_eq!(fold_notch_metrics(seeded, NotchMetrics::default()), seeded);
        // Each field folds independently.
        let wider = fold_notch_metrics(
            seeded,
            NotchMetrics {
                inset: 0.0,
                width: 420.0,
            },
        );
        assert_eq!(
            wider,
            NotchMetrics {
                inset: 74.0,
                width: 420.0
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
            notch_width: 200.0,
            fullscreen: true,
        })
        .unwrap();
        assert_eq!(
            json,
            r#"{"topInset":37.0,"notchWidth":200.0,"fullscreen":true}"#
        );
    }

    #[test]
    fn debug_dump_payload_is_camel_case() {
        let json = serde_json::to_value(IslandDebugGeometry {
            displays: Vec::new(),
            preferred_monitor: None,
            window_position: Some([10.0, 0.0]),
            window_size: Some([840.0, 74.0]),
            window_scale: Some(2.0),
            target_frame: [5.0, 0.0, 420.0, 37.0],
            window_visible: true,
            geometry: IslandGeometry {
                top_inset: 37.0,
                notch_width: 200.0,
                fullscreen: false,
            },
        })
        .unwrap();
        assert_eq!(json["windowScale"], 2.0);
        assert_eq!(
            json["targetFrame"],
            serde_json::json!([5.0, 0.0, 420.0, 37.0])
        );
        assert_eq!(json["windowVisible"], true);
        assert!(json.get("window_scale").is_none());
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

    // The Island panel statics are process-wide and shared with
    // `pet_window::macos_panel`'s tests, so each of these three holds the same
    // serialization lock for its whole body.
    #[test]
    fn opening_the_island_arms_its_native_panel_reveal() {
        let _serial = crate::pet_window::lock_overlay_panel_state_for_test();
        let generation = begin_island_panel_open();
        let role = crate::pet_window::OverlayPanelRole::Island;

        assert!(crate::pet_window::overlay_panel_generation_is_current(
            role, generation
        ));

        crate::pet_window::cancel_overlay_panel_reveal(role);
    }

    #[test]
    fn island_panel_builds_are_serialized() {
        let _serial = crate::pet_window::lock_overlay_panel_state_for_test();
        let role = crate::pet_window::OverlayPanelRole::Island;
        let first = crate::pet_window::try_begin_overlay_panel_build(role)
            .expect("first island build should claim the lifecycle");

        assert!(crate::pet_window::try_begin_overlay_panel_build(role).is_none());

        drop(first);
        assert!(crate::pet_window::try_begin_overlay_panel_build(role).is_some());
    }

    #[test]
    fn closing_cancels_an_island_open_waiting_for_the_build_guard() {
        let _serial = crate::pet_window::lock_overlay_panel_state_for_test();
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
