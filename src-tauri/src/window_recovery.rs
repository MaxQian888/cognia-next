// Off-screen window recovery.
//
// `tauri_plugin_window_state` restores the main window's last position/size on
// launch. If the previous session exited on a monitor that is no longer
// present (laptop undocked, external display unplugged, displays rearranged),
// the restored rect can land entirely outside every live monitor — the app
// boots alive but its window is unreachable. We already drop the FULLSCREEN
// restore flag in `lib.rs` (a fullscreen Space on an absent display can't be
// recovered by repositioning); this module covers the windowed case by
// re-centering the window when its restored rect doesn't overlap any monitor.
//
// The geometry test (`is_rect_visible`) is a pure function so it can be unit
// tested without a live window/monitor. The `recenter_if_offscreen` wrapper is
// the thin Tauri-IO seam around it (read monitors + outer rect, `center()` on
// miss) and is exercised by every desktop launch rather than a mock — mirroring
// the convention documented in `window_utils.rs`.

use tauri::{Runtime, WebviewWindow};

/// A screen-space rectangle in **physical** pixels. Tauri's `Monitor` and
/// `WebviewWindow::{outer_position, outer_size}` are all physical, so the whole
/// computation stays in one coordinate space (see the
/// `tauri-runtime-window-physical-position` note — mixing logical builder
/// coordinates with physical monitor geometry is what sends Retina windows
/// off-screen in the first place).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    pub fn new(x: i32, y: i32, w: i32, h: i32) -> Self {
        Self { x, y, w, h }
    }

    fn right(&self) -> i64 {
        self.x as i64 + self.w.max(0) as i64
    }

    fn bottom(&self) -> i64 {
        self.y as i64 + self.h.max(0) as i64
    }

    fn area(&self) -> i64 {
        self.w.max(0) as i64 * self.h.max(0) as i64
    }
}

/// Area of the overlap between two rectangles (0 when they don't intersect).
fn intersection_area(a: &Rect, b: &Rect) -> i64 {
    let ix = (a.right().min(b.right()) - (a.x as i64).max(b.x as i64)).max(0);
    let iy = (a.bottom().min(b.bottom()) - (a.y as i64).max(b.y as i64)).max(0);
    ix * iy
}

/// Minimum fraction of the window that must overlap some monitor for the window
/// to count as user-reachable. A window peeking only a sliver onto a live
/// monitor is effectively lost, so we require a meaningful chunk (20%) to be on
/// screen before leaving it where the plugin restored it.
pub const MIN_VISIBLE_RATIO: f64 = 0.2;

/// True when `win` overlaps at least one monitor by [`MIN_VISIBLE_RATIO`] of its
/// own area. A degenerate (zero-area) window, or an empty monitor list, counts
/// as not visible so the caller re-centers onto the primary display.
pub fn is_rect_visible(win: &Rect, monitors: &[Rect]) -> bool {
    let win_area = win.area();
    if win_area <= 0 || monitors.is_empty() {
        return false;
    }
    let best_overlap = monitors
        .iter()
        .map(|m| intersection_area(win, m))
        .max()
        .unwrap_or(0);
    best_overlap as f64 >= win_area as f64 * MIN_VISIBLE_RATIO
}

/// Re-center the window if its restored rect doesn't sufficiently overlap any
/// live monitor. Best-effort: any failure to read geometry leaves the window
/// untouched (the plugin's restore is still better than nothing).
pub fn recenter_if_offscreen<R: Runtime>(window: &WebviewWindow<R>) {
    let monitors = match window.available_monitors() {
        Ok(monitors) if !monitors.is_empty() => monitors,
        _ => return,
    };
    let monitor_rects: Vec<Rect> = monitors
        .iter()
        .map(|m| {
            let p = m.position();
            let s = m.size();
            Rect::new(p.x, p.y, s.width as i32, s.height as i32)
        })
        .collect();

    let pos = match window.outer_position() {
        Ok(pos) => pos,
        Err(_) => return,
    };
    let size = match window.outer_size() {
        Ok(size) => size,
        Err(_) => return,
    };
    let win = Rect::new(pos.x, pos.y, size.width as i32, size.height as i32);

    if !is_rect_visible(&win, &monitor_rects) {
        log::warn!(
            "main window restored off-screen at ({}, {}) {}x{}; recentering onto a live monitor",
            win.x,
            win.y,
            win.w,
            win.h
        );
        let _ = window.center();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn monitor() -> Rect {
        Rect::new(0, 0, 1920, 1080)
    }

    #[test]
    fn fully_on_primary_monitor_is_visible() {
        let win = Rect::new(100, 100, 1200, 800);
        assert!(is_rect_visible(&win, &[monitor()]));
    }

    #[test]
    fn fully_off_screen_is_not_visible() {
        // Restored onto a monitor that no longer exists (e.g. 4K at 3840,0).
        let win = Rect::new(5000, 5000, 1200, 800);
        assert!(!is_rect_visible(&win, &[monitor()]));
    }

    #[test]
    fn negative_offscreen_is_not_visible() {
        let win = Rect::new(-2000, -2000, 1200, 800);
        assert!(!is_rect_visible(&win, &[monitor()]));
    }

    #[test]
    fn small_sliver_overlap_is_not_visible() {
        // Only the leftmost 40px of a 1200px-wide window touches the monitor's
        // right edge: 40/1200 ≈ 3.3% < 20%.
        let win = Rect::new(1880, 100, 1200, 800);
        assert!(!is_rect_visible(&win, &[monitor()]));
    }

    #[test]
    fn majority_overlap_is_visible() {
        // Window straddles the right edge but keeps ~46% on screen.
        let win = Rect::new(1100, 100, 1200, 800); // 820/1200 ≈ 68% wide overlap
        assert!(is_rect_visible(&win, &[monitor()]));
    }

    #[test]
    fn exactly_at_threshold_is_visible() {
        // 20% width overlap, full height overlap → 20% area, which meets the
        // `>=` threshold.
        let win = Rect::new(1920 - 240, 0, 1200, 1080); // 240/1200 = 20%
        assert!(is_rect_visible(&win, &[monitor()]));
    }

    #[test]
    fn just_below_threshold_is_not_visible() {
        let win = Rect::new(1920 - 239, 0, 1200, 1080); // 239/1200 ≈ 19.9%
        assert!(!is_rect_visible(&win, &[monitor()]));
    }

    #[test]
    fn visible_on_secondary_monitor() {
        let primary = Rect::new(0, 0, 1920, 1080);
        let secondary = Rect::new(1920, 0, 2560, 1440);
        let win = Rect::new(2200, 200, 1200, 800);
        assert!(is_rect_visible(&win, &[primary, secondary]));
        // ...and off both is not visible.
        let lost = Rect::new(9000, 9000, 1200, 800);
        assert!(!is_rect_visible(&lost, &[primary, secondary]));
    }

    #[test]
    fn empty_monitor_list_is_not_visible() {
        let win = Rect::new(100, 100, 1200, 800);
        assert!(!is_rect_visible(&win, &[]));
    }

    #[test]
    fn zero_area_window_is_not_visible() {
        assert!(!is_rect_visible(&Rect::new(0, 0, 0, 0), &[monitor()]));
        assert!(!is_rect_visible(&Rect::new(100, 100, 1200, 0), &[monitor()]));
    }

    #[test]
    fn intersection_area_is_zero_when_disjoint() {
        let a = Rect::new(0, 0, 100, 100);
        let b = Rect::new(200, 200, 100, 100);
        assert_eq!(intersection_area(&a, &b), 0);
    }

    #[test]
    fn intersection_area_matches_overlap() {
        let a = Rect::new(0, 0, 100, 100);
        let b = Rect::new(50, 50, 100, 100);
        // Overlap is the 50x50 square at (50,50)..(100,100).
        assert_eq!(intersection_area(&a, &b), 2500);
    }
}
