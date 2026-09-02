//! The Capacity Dock: a transparent edge rail showing live provider gauges
//! (ADR-0165 Phase 2).
//!
//! Same window recipe as the fleet island (`fleet/island_window.rs`) and the
//! desktop pet: transparent, frameless, always-on-top, skip-taskbar, created
//! hidden and revealed by the renderer after first paint (the Windows
//! black-rectangle bug), and reclassed on macOS to a non-activating NSPanel
//! through the shared pet panel seam.
//!
//! Where it differs from the island, and why:
//!
//!   * FOUR EDGES, not one anchor. All of that math is pure and lives in
//!     `placement.rs`, so the contract is unit-tested on every platform
//!     rather than only smoke-tested on a packaged app.
//!   * WORK AREA, not the full frame. The island deliberately anchors to the
//!     full monitor frame so it can hug the true top edge under the notch. A
//!     dock must sit beside the Dock and the taskbar, not under them, so the
//!     work area is the correct anchor on all three platforms.
//!   * NEVER KEY. The rail is a read-only gauge with no text input, so
//!     `PetPanelRole::UsageDock` refuses key status outright rather than
//!     merely avoiding it.
//!
//! Live window operations cannot run under `tauri::test::mock_app()` on this
//! project's toolchains (documented in `pet_window/mod.rs`), so only the pure
//! placement math is unit-tested here. Runtime behaviour is covered by
//! `tauri-smoke` on each platform.

pub mod placement;

use placement::{DockEdge, Rect};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, Runtime};

pub const USAGE_DOCK_LABEL: &str = "usage-dock";

/// Cursor-over-dock transitions pushed by the native hover monitor.
///
/// The renderer needs them because a click-through rail never receives DOM
/// mouseenter at the OS level, exactly as with the island. Without this the
/// collapsed rail could never expand on hover.
pub const USAGE_DOCK_HOVER_EVENT: &str = "usage-dock://hover";

/// Geometry pushed after any placement path that may have changed the monitor,
/// so the renderer can re-orient its rail without polling.
pub const USAGE_DOCK_GEOMETRY_EVENT: &str = "usage-dock://geometry";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageDockHover {
    pub hovering: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageDockGeometry {
    pub edge: DockEdge,
    /// Work-area size in logical px, so the renderer can bound its own layout.
    pub area_width: f64,
    pub area_height: f64,
    pub scale: f64,
}

/// Hover poll cadence while the dock is visible. Same budget as the island:
/// coarse enough to be free, fine enough that a reveal feels immediate.
const HOVER_POLL_MS: u64 = 120;
/// Idle cadence while the dock is hidden.
const HOVER_POLL_HIDDEN_MS: u64 = 500;

/// Single-flight guard for the hover monitor task.
static HOVER_MONITOR_RUNNING: AtomicBool = AtomicBool::new(false);

/// Persisted dock GEOMETRY (`<cognia-home>/usage-dock.json`).
///
/// Deliberately not visibility. The renderer's `usageDock.preferences.v1`
/// owns whether the dock shows, and duplicating that here would give the
/// question two answers that drift the first time one write fails. What Rust
/// owns is where the window goes, because a drag-snap changes the edge
/// natively and the renderer would otherwise have to be told and believed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct UsageDockConfig {
    pub edge: DockEdge,
    /// Preferred monitor name (`Monitor::name`). `None` means primary.
    pub monitor: Option<String>,
    /// Normalized position along the edge, 0.0 to 1.0.
    pub offset: f64,
    /// Absolute position for a floating dock, physical px.
    pub floating_x: f64,
    pub floating_y: f64,
    /// User size multiplier, clamped to `placement::MIN_SCALE..=MAX_SCALE`.
    pub scale: f64,
    /// Withdraw while a full-screen app owns the dock's display.
    pub hide_on_fullscreen: bool,
}

impl Default for UsageDockConfig {
    fn default() -> Self {
        Self {
            edge: DockEdge::Right,
            monitor: None,
            offset: 0.5,
            floating_x: 0.0,
            floating_y: 0.0,
            scale: 1.0,
            hide_on_fullscreen: false,
        }
    }
}

fn config_path() -> Option<std::path::PathBuf> {
    crate::agents::paths::cognia_home().map(|home| home.join("usage-dock.json"))
}

fn load_config() -> UsageDockConfig {
    config_path()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_config(cfg: &UsageDockConfig) -> Result<(), String> {
    let path = config_path().ok_or_else(|| "cannot resolve cognia home".to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

/// Mutate the persisted config. Best-effort: failing to persist a preference
/// must never fail the window operation the user actually asked for.
fn update_config(mutate: impl FnOnce(&mut UsageDockConfig)) -> UsageDockConfig {
    let mut cfg = load_config();
    mutate(&mut cfg);
    if let Err(e) = save_config(&cfg) {
        log::warn!("usage-dock: persisting config failed: {e}");
    }
    cfg
}

/// The monitor the dock should live on: the preferred one when it is still
/// connected, else the primary.
fn resolve_monitor<R: Runtime>(
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

/// The work area the dock anchors to, in physical px, plus the scale factor.
///
/// The WORK area on every platform, unlike the island's full-frame anchor: a
/// rail that overlapped the macOS Dock or the Windows taskbar would be sitting
/// on top of the very controls it is docked beside.
fn dock_area<R: Runtime>(app: &AppHandle<R>, cfg: &UsageDockConfig) -> (Rect, f64) {
    let Some(monitor) = resolve_monitor(app, cfg.monitor.as_deref()) else {
        return (
            Rect {
                x: 0.0,
                y: 0.0,
                w: 1920.0,
                h: 1080.0,
            },
            1.0,
        );
    };
    let area = monitor.work_area();
    (
        Rect {
            x: area.position.x as f64,
            y: area.position.y as f64,
            w: area.size.width as f64,
            h: area.size.height as f64,
        },
        monitor.scale_factor(),
    )
}

/// Place the window against the persisted edge and push the geometry event.
fn reposition<R: Runtime>(
    app: &AppHandle<R>,
    window: &tauri::WebviewWindow<R>,
    cfg: &UsageDockConfig,
) -> Result<(), String> {
    let (area, scale) = dock_area(app, cfg);
    let size = window
        .outer_size()
        .map(|s| (s.width as f64, s.height as f64))
        .unwrap_or((60.0, 200.0));
    let (x, y) = if cfg.edge == DockEdge::Floating {
        placement::resolve_floating_position(area, size, (cfg.floating_x, cfg.floating_y))
    } else {
        placement::resolve_position(cfg.edge, area, size, cfg.offset)
    };
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    let _ = app.emit_to(
        USAGE_DOCK_LABEL,
        USAGE_DOCK_GEOMETRY_EVENT,
        UsageDockGeometry {
            edge: cfg.edge,
            area_width: area.w / scale,
            area_height: area.h / scale,
            scale,
        },
    );
    Ok(())
}

/// Is the global cursor over the dock right now?
///
/// `false` on any query failure, so a broken query can only ever collapse the
/// rail, never pin it open on top of the user's work.
fn cursor_inside<R: Runtime>(window: &tauri::WebviewWindow<R>) -> bool {
    let (Ok(cursor), Ok(pos), Ok(size)) = (
        window.cursor_position(),
        window.outer_position(),
        window.outer_size(),
    ) else {
        return false;
    };
    placement::point_in_rect(
        (cursor.x, cursor.y),
        (pos.x as f64, pos.y as f64),
        (size.width as f64, size.height as f64),
    )
}

/// Poll the global cursor against the dock frame and push enter/leave
/// transitions. This is the dock's authoritative hover source while the rail
/// is click-through, exactly as for the island.
fn spawn_hover_monitor<R: Runtime>(app: &AppHandle<R>) {
    if HOVER_MONITOR_RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut was_inside = false;
        loop {
            let Some(window) = app.get_webview_window(USAGE_DOCK_LABEL) else {
                HOVER_MONITOR_RUNNING.store(false, Ordering::SeqCst);
                return;
            };
            if !window.is_visible().unwrap_or(false) {
                was_inside = false;
                tokio::time::sleep(std::time::Duration::from_millis(HOVER_POLL_HIDDEN_MS)).await;
                continue;
            }
            let inside = cursor_inside(&window);
            if inside != was_inside {
                was_inside = inside;
                let _ = app.emit_to(
                    USAGE_DOCK_LABEL,
                    USAGE_DOCK_HOVER_EVENT,
                    UsageDockHover { hovering: inside },
                );
            }
            tokio::time::sleep(std::time::Duration::from_millis(HOVER_POLL_MS)).await;
        }
    });
}

const DEFAULT_DOCK_WIDTH: f64 = 56.0;
const DEFAULT_DOCK_HEIGHT: f64 = 200.0;

fn open_claimed<R: Runtime>(app: &AppHandle<R>, generation: u64) -> Result<(), String> {
    let role = crate::pet_window::OverlayPanelRole::UsageDock;
    if !crate::pet_window::overlay_panel_generation_is_current(role, generation) {
        return Ok(());
    }
    let cfg = load_config();

    if let Some(window) = app.get_webview_window(USAGE_DOCK_LABEL) {
        let _ = reposition(app, &window, &cfg);
        if let Err(error) =
            crate::pet_window::reveal_overlay_panel(&window, role, false, generation)
        {
            crate::pet_window::cancel_overlay_panel_reveal(role);
            return Err(error);
        }
        spawn_hover_monitor(app);
        return Ok(());
    }

    let (area, scale) = dock_area(app, &cfg);
    let logical = (DEFAULT_DOCK_WIDTH, DEFAULT_DOCK_HEIGHT);
    let physical = (logical.0 * scale, logical.1 * scale);
    let (x, y) = if cfg.edge == DockEdge::Floating {
        placement::resolve_floating_position(area, physical, (cfg.floating_x, cfg.floating_y))
    } else {
        placement::resolve_position(cfg.edge, area, physical, cfg.offset)
    };

    let window = tauri::WebviewWindowBuilder::new(
        app,
        USAGE_DOCK_LABEL,
        tauri::WebviewUrl::App("usage-dock".into()),
    )
    // `transparent(true)` only, never `.background_color(...)`, which forces an
    // opaque layer on Windows. The page paints itself transparent.
    .transparent(true)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .shadow(false)
    // Created hidden. On Windows a transparent window shown before its first
    // paint renders as a black rectangle, so the renderer signals readiness.
    .visible(false)
    .inner_size(logical.0, logical.1)
    .build()
    .map_err(|error| {
        crate::pet_window::cancel_overlay_panel_reveal(role);
        error.to_string()
    })?;

    // Strip the app menu bar on Windows/Linux, same as the other overlays.
    let _ = window.remove_menu();

    if let Err(error) = window.set_position(PhysicalPosition::new(x, y)) {
        crate::pet_window::cancel_overlay_panel_reveal(role);
        let _ = window.close();
        return Err(error.to_string());
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

    spawn_hover_monitor(app);

    // Safety net for a renderer that never signals first paint. Without it a
    // hung hydrate strands an invisible window that the user cannot recover
    // except by toggling the setting off and on.
    {
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(8)).await;
            if !crate::pet_window::overlay_panel_generation_is_current(role, generation) {
                return;
            }
            if let Some(window) = handle.get_webview_window(USAGE_DOCK_LABEL) {
                if !window.is_visible().unwrap_or(true) {
                    log::warn!(
                        "usage-dock still hidden 8s after open, force-showing (renderer never signaled first paint)"
                    );
                    let _ =
                        crate::pet_window::reveal_overlay_panel(&window, role, false, generation);
                }
            }
        });
    }

    Ok(())
}

/// Open or re-show the dock. Idempotent, and serialized against a concurrent
/// open the same way the island's is.
pub(crate) fn open_inner<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let role = crate::pet_window::OverlayPanelRole::UsageDock;
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
                    log::error!("usage-dock: queued open failed: {error}");
                }
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        log::error!("usage-dock: timed out waiting for the window lifecycle to become idle");
    });
    Ok(())
}

pub(crate) fn close_inner<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    crate::pet_window::cancel_overlay_panel_reveal(crate::pet_window::OverlayPanelRole::UsageDock);
    if let Some(window) = app.get_webview_window(USAGE_DOCK_LABEL) {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/* ── Commands ──────────────────────────────────────────────────────────── */

#[tauri::command]
pub async fn usage_dock_open(app: AppHandle) -> Result<(), String> {
    open_inner(&app)
}

#[tauri::command]
pub async fn usage_dock_close(app: AppHandle) -> Result<(), String> {
    close_inner(&app)
}

#[tauri::command]
pub async fn usage_dock_is_open(app: AppHandle) -> bool {
    app.get_webview_window(USAGE_DOCK_LABEL)
        .map(|w| w.is_visible().unwrap_or(false))
        .unwrap_or(false)
}

/// Renderer-driven first-paint reveal. Same contract as the island's.
#[tauri::command]
pub async fn usage_dock_reveal(window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != USAGE_DOCK_LABEL {
        return Err(format!(
            "usage_dock_reveal is only callable from the {USAGE_DOCK_LABEL} window"
        ));
    }
    let role = crate::pet_window::OverlayPanelRole::UsageDock;
    let generation = crate::pet_window::current_overlay_panel_generation(role);
    crate::pet_window::reveal_overlay_panel(&window, role, false, generation)
}

/// Resize the rail to the renderer's measured content and re-place it.
///
/// Re-placing is not optional: growing a rail docked to the RIGHT edge without
/// moving it would push its left edge inward and leave a gap at the screen
/// edge, which is the single most obvious way an edge rail can look broken.
#[tauri::command]
pub async fn usage_dock_resize(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    let Some(window) = app.get_webview_window(USAGE_DOCK_LABEL) else {
        return Ok(());
    };
    let cfg = load_config();
    let (area, scale) = dock_area(&app, &cfg);
    let (w, h) = placement::clamp_size((width * scale, height * scale), area);
    window
        .set_size(tauri::PhysicalSize::new(w, h))
        .map_err(|e| e.to_string())?;
    reposition(&app, &window, &cfg)
}

/// Pin the dock to an edge, or drop it into floating mode at a point.
#[tauri::command]
pub async fn usage_dock_set_placement(
    app: AppHandle,
    edge: DockEdge,
    offset: Option<f64>,
    floating_x: Option<f64>,
    floating_y: Option<f64>,
) -> Result<(), String> {
    let cfg = update_config(|cfg| {
        cfg.edge = edge;
        if let Some(offset) = offset {
            if offset.is_finite() {
                cfg.offset = offset.clamp(0.0, 1.0);
            }
        }
        if let Some(x) = floating_x {
            if x.is_finite() {
                cfg.floating_x = x;
            }
        }
        if let Some(y) = floating_y {
            if y.is_finite() {
                cfg.floating_y = y;
            }
        }
    });
    if let Some(window) = app.get_webview_window(USAGE_DOCK_LABEL) {
        reposition(&app, &window, &cfg)?;
    }
    Ok(())
}

/// Snap a drag that ended at `x`/`y` (physical px) to the nearest edge, or
/// leave it floating. Returns the edge that was committed so the renderer can
/// reorient without a round trip.
#[tauri::command]
pub async fn usage_dock_snap(app: AppHandle, x: f64, y: f64) -> Result<DockEdge, String> {
    let cfg = load_config();
    let (area, _scale) = dock_area(&app, &cfg);
    let size = app
        .get_webview_window(USAGE_DOCK_LABEL)
        .and_then(|w| w.outer_size().ok())
        .map(|s| (s.width as f64, s.height as f64))
        .unwrap_or((DEFAULT_DOCK_WIDTH, DEFAULT_DOCK_HEIGHT));
    let edge = placement::snap_edge(area, size, (x, y));
    let offset = placement::offset_from_position(edge, area, size, (x, y));
    let committed = update_config(|cfg| {
        cfg.edge = edge;
        if edge == DockEdge::Floating {
            cfg.floating_x = x;
            cfg.floating_y = y;
        } else {
            cfg.offset = offset;
        }
    });
    if let Some(window) = app.get_webview_window(USAGE_DOCK_LABEL) {
        reposition(&app, &window, &committed)?;
    }
    Ok(edge)
}

/// Make the rail transparent to the cursor while collapsed.
///
/// A collapsed rail is a thin strip, but its window still spans the full
/// expanded footprint. Without this it silently swallows clicks aimed at
/// whatever sits behind it, which on the right edge of a screen is usually a
/// scrollbar. The hover monitor above keeps the reveal working while it is on.
#[tauri::command]
pub async fn usage_dock_set_click_through(app: AppHandle, ignore: bool) -> Result<(), String> {
    let Some(window) = app.get_webview_window(USAGE_DOCK_LABEL) else {
        return Ok(());
    };
    app.run_on_main_thread(move || {
        if let Err(e) = window.set_ignore_cursor_events(ignore) {
            log::warn!("usage-dock: set_ignore_cursor_events({ignore}) failed: {e}");
        }
    })
    .map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageDockMonitorInfo {
    pub name: Option<String>,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
    pub is_primary: bool,
    pub is_preferred: bool,
}

#[tauri::command]
pub async fn usage_dock_list_monitors(app: AppHandle) -> Result<Vec<UsageDockMonitorInfo>, String> {
    let preferred = load_config().monitor;
    let primary_pos = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| (m.position().x, m.position().y));
    let monitors = app.available_monitors().map_err(|e| e.to_string())?;
    Ok(monitors
        .into_iter()
        .map(|m| {
            let name = m.name().cloned();
            UsageDockMonitorInfo {
                is_primary: primary_pos == Some((m.position().x, m.position().y)),
                is_preferred: preferred.is_some() && preferred == name,
                width: m.size().width,
                height: m.size().height,
                scale: m.scale_factor(),
                name,
            }
        })
        .collect())
}

#[tauri::command]
pub async fn usage_dock_set_monitor(app: AppHandle, monitor: Option<String>) -> Result<(), String> {
    let cfg = update_config(|cfg| cfg.monitor = monitor);
    if let Some(window) = app.get_webview_window(USAGE_DOCK_LABEL) {
        reposition(&app, &window, &cfg)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn usage_dock_get_config() -> UsageDockConfig {
    load_config()
}

#[tauri::command]
pub async fn usage_dock_set_scale(app: AppHandle, scale: f64) -> Result<f64, String> {
    let cfg = update_config(|cfg| cfg.scale = placement::clamp_scale(scale));
    if let Some(window) = app.get_webview_window(USAGE_DOCK_LABEL) {
        reposition(&app, &window, &cfg)?;
    }
    Ok(cfg.scale)
}

/// What this platform can actually do for the dock.
///
/// Reported rather than assumed, because a Wayland compositor may refuse
/// positioning, always-on-top, or global cursor queries outright. A dock that
/// silently fails there is worse than one that says it cannot run and leaves
/// the user on the tray.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageDockCapabilities {
    /// The window can be placed at an absolute position.
    pub positioning: bool,
    /// The window can float above other applications.
    pub always_on_top: bool,
    /// The global cursor can be polled, which is what drives hover reveal.
    pub global_hover: bool,
    /// Coarse platform id, so the renderer can explain the specific limitation.
    pub platform: &'static str,
    /// Present when the dock cannot run here, naming the reason in a way the
    /// UI can translate.
    pub blocked_reason: Option<&'static str>,
}

/// Probe what the running desktop supports.
///
/// The macOS and Windows answers are static. The Linux answer is not: X11 is
/// fully capable while a Wayland session usually refuses client-side window
/// positioning, and guessing would ship a rail that never appears.
#[tauri::command]
pub async fn usage_dock_capabilities(app: AppHandle) -> UsageDockCapabilities {
    #[cfg(target_os = "macos")]
    {
        let _ = &app;
        UsageDockCapabilities {
            positioning: true,
            always_on_top: true,
            global_hover: true,
            platform: "macos",
            blocked_reason: None,
        }
    }
    #[cfg(target_os = "windows")]
    {
        let _ = &app;
        UsageDockCapabilities {
            positioning: true,
            always_on_top: true,
            global_hover: true,
            platform: "windows",
            blocked_reason: None,
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let wayland = std::env::var("WAYLAND_DISPLAY").is_ok()
            || std::env::var("XDG_SESSION_TYPE")
                .map(|v| v.eq_ignore_ascii_case("wayland"))
                .unwrap_or(false);
        // A Wayland session under XWayland still positions windows, and Tauri
        // reports a usable monitor list there. Treat "no monitors" as the real
        // signal rather than the session type alone, so an XWayland user is not
        // refused a dock that would have worked.
        let positioning = !wayland
            || app
                .available_monitors()
                .map(|m| !m.is_empty())
                .unwrap_or(false);
        UsageDockCapabilities {
            positioning,
            always_on_top: positioning,
            global_hover: positioning,
            platform: "linux",
            blocked_reason: if positioning {
                None
            } else {
                Some("waylandPositioning")
            },
        }
    }
}
