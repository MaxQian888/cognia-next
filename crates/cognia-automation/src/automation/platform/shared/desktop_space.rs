//! The screen coordinate space desktop overlays are placed in ("desktop
//! units"), and the conversions into it.
//!
//! Selection anchors, pointer events and screen captures all speak the
//! platform's *native* desktop space:
//!
//!   - **macOS** — global points (logical), origin at the top-left of the
//!     primary display. `AXBoundsForRange`, `CGEvent` locations and
//!     `CGDisplayBounds` all report here, whatever each display's scale.
//!   - **Windows / Linux** — physical pixels. UIA bounding rects, low-level
//!     hook coordinates (the process is per-monitor DPI aware) and monitor
//!     rects all report here.
//!
//! Tauri (tao) reports every monitor and window rect as "physical" pixels
//! instead. On Windows that is the same space; on macOS it is each display's
//! logical rect multiplied by *that display's own* backing scale, so it is not
//! even continuous across displays of different scale and can never be
//! compared with an AX point directly. Everything here converts tao's numbers
//! into desktop units, so placement math happens in exactly one space.
//!
//! Pure on purpose: every bug this module exists to prevent (a toolbar at half
//! its coordinates on a Retina display, on the wrong monitor, or in the
//! top-left corner) is a unit mix-up that a unit test can pin on any host.

use crate::automation::types::Rect;

/// Whether desktop units are logical points (macOS) rather than physical
/// pixels (everywhere else).
pub const DESKTOP_UNITS_ARE_POINTS: bool = cfg!(target_os = "macos");

/// One display, in desktop units.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DesktopMonitor {
    /// The whole display.
    pub bounds: Rect,
    /// The display minus the menu bar / dock / taskbar.
    pub work: Rect,
    /// Desktop units per logical (CSS) pixel on this display: `1.0` where
    /// desktop units are points, the display's scale factor where they are
    /// pixels. Multiplies a renderer-measured size into desktop units.
    pub content_scale: f64,
}

fn finite_scale(scale_factor: f64) -> f64 {
    if scale_factor.is_finite() && scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    }
}

fn divide_rect(rect: Rect, scale: f64) -> Rect {
    Rect {
        x: (f64::from(rect.x) / scale).round() as i32,
        y: (f64::from(rect.y) / scale).round() as i32,
        width: (f64::from(rect.width) / scale).round() as i32,
        height: (f64::from(rect.height) / scale).round() as i32,
    }
}

impl DesktopMonitor {
    /// Convert a monitor as tao reports it — `bounds` and `work` in its
    /// "physical" pixels, plus the display's own scale factor.
    pub fn from_tao(bounds: Rect, work: Rect, scale_factor: f64, units_are_points: bool) -> Self {
        let scale = finite_scale(scale_factor);
        if units_are_points {
            // tao multiplied the display's logical rect by its own scale;
            // dividing by that same scale recovers the points exactly.
            Self {
                bounds: divide_rect(bounds, scale),
                work: divide_rect(work, scale),
                content_scale: 1.0,
            }
        } else {
            Self {
                bounds,
                work,
                content_scale: scale,
            }
        }
    }
}

/// A window's outer frame in desktop units, from tao's `outer_position` /
/// `outer_size` and the window's current scale factor. On macOS tao derived
/// both from the window's logical frame times that scale, so dividing by it
/// recovers points regardless of which display the window is on.
pub fn window_frame(
    outer_position: (i32, i32),
    outer_size: (u32, u32),
    window_scale_factor: f64,
    units_are_points: bool,
) -> Rect {
    let physical = Rect {
        x: outer_position.0,
        y: outer_position.1,
        width: i32::try_from(outer_size.0).unwrap_or(i32::MAX),
        height: i32::try_from(outer_size.1).unwrap_or(i32::MAX),
    };
    if units_are_points {
        divide_rect(physical, finite_scale(window_scale_factor))
    } else {
        physical
    }
}

/// tao's `cursor_position` in desktop units. On macOS tao reports the global
/// point multiplied by the PRIMARY display's scale, whichever display the
/// cursor is on, so dividing by that scale recovers the point. Elsewhere it is
/// already a physical pixel.
pub fn cursor_point(
    cursor: (f64, f64),
    primary_scale_factor: f64,
    units_are_points: bool,
) -> (i32, i32) {
    let scale = if units_are_points {
        finite_scale(primary_scale_factor)
    } else {
        1.0
    };
    (
        (cursor.0 / scale).round() as i32,
        (cursor.1 / scale).round() as i32,
    )
}

/// Desktop units per logical (CSS) pixel for a window on its current display.
pub fn window_content_scale(window_scale_factor: f64, units_are_points: bool) -> f64 {
    if units_are_points {
        1.0
    } else {
        finite_scale(window_scale_factor)
    }
}

/// Scale a logical (CSS) length into desktop units, rounding to whole units.
pub fn logical_to_desktop(length: f64, content_scale: f64) -> i32 {
    (length * content_scale).round() as i32
}

fn center(rect: Rect) -> (i32, i32) {
    (rect.x + rect.width / 2, rect.y + rect.height / 2)
}

fn contains(rect: Rect, (x, y): (i32, i32)) -> bool {
    x >= rect.x
        && y >= rect.y
        && x < rect.x.saturating_add(rect.width)
        && y < rect.y.saturating_add(rect.height)
}

/// Squared distance from a point to the nearest edge of a rect (0 inside).
fn distance_sq(rect: Rect, (x, y): (i32, i32)) -> i64 {
    let dx = if x < rect.x {
        i64::from(rect.x - x)
    } else if x >= rect.x.saturating_add(rect.width) {
        i64::from(x - (rect.x.saturating_add(rect.width) - 1))
    } else {
        0
    };
    let dy = if y < rect.y {
        i64::from(rect.y - y)
    } else if y >= rect.y.saturating_add(rect.height) {
        i64::from(y - (rect.y.saturating_add(rect.height) - 1))
    } else {
        0
    };
    dx * dx + dy * dy
}

/// The display an anchor belongs to: the one containing its centre, else the
/// nearest one (an anchor can sit a few units past a screen edge, e.g. a
/// selection scrolled partly out of view). `None` only with no displays.
pub fn monitor_for(anchor: Rect, monitors: &[DesktopMonitor]) -> Option<&DesktopMonitor> {
    let point = center(anchor);
    monitors
        .iter()
        .find(|monitor| contains(monitor.bounds, point))
        .or_else(|| {
            monitors
                .iter()
                .min_by_key(|monitor| distance_sq(monitor.bounds, point))
        })
}

/// Whether a reported selection rect is usable as a placement anchor.
///
/// Accessibility bounds are not always trustworthy: Chromium / Electron text
/// fields and some native controls answer `AXBoundsForRange` with an empty
/// rect at the origin, and a few return a rect for a document that is not on
/// any screen. Either would park the toolbar in a corner. A usable anchor has
/// height, and its centre is on a display.
pub fn plausible_anchor(rect: Rect, monitors: &[DesktopMonitor]) -> bool {
    if rect.height < 1 || rect.width < 0 {
        return false;
    }
    monitors.is_empty()
        || monitors
            .iter()
            .any(|monitor| contains(monitor.bounds, center(rect)))
}

/// The rect to place an overlay against, in order of preference: the
/// selection's own bounds when plausible, then the last pointer position, then
/// the middle of the first display's work area (callers list the primary
/// display first), and only with no displays at all, the origin.
pub fn resolve_anchor(
    selection: Option<Rect>,
    pointer: Option<(i32, i32)>,
    monitors: &[DesktopMonitor],
) -> Rect {
    if let Some(rect) = selection.filter(|rect| plausible_anchor(*rect, monitors)) {
        return rect;
    }
    let point = |(x, y): (i32, i32)| Rect {
        x,
        y,
        width: 1,
        height: 1,
    };
    if let Some(pointer) = pointer {
        return point(pointer);
    }
    monitors
        .first()
        .map(|monitor| point(center(monitor.work)))
        .unwrap_or(Rect {
            x: 0,
            y: 0,
            width: 1,
            height: 1,
        })
}

/// Clip an anchor to its display, so an overlay anchored to a selection that
/// extends off-screen (or is taller than the screen) stays next to the part
/// the user can see. An anchor entirely off the display is left alone; the
/// caller's clamp brings the overlay back on screen.
pub fn clip_to(anchor: Rect, bounds: Rect) -> Rect {
    let left = anchor.x.max(bounds.x);
    let top = anchor.y.max(bounds.y);
    let right = anchor
        .x
        .saturating_add(anchor.width)
        .min(bounds.x.saturating_add(bounds.width));
    let bottom = anchor
        .y
        .saturating_add(anchor.height)
        .min(bounds.y.saturating_add(bounds.height));
    if right < left || bottom < top {
        return anchor;
    }
    Rect {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: i32, y: i32, width: i32, height: i32) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    /// A 1512×982pt Retina laptop (scale 2) at the origin, and a 2560×1440pt
    /// display (scale 1) to its right — as tao reports them.
    fn mac_pair() -> Vec<DesktopMonitor> {
        vec![
            DesktopMonitor::from_tao(rect(0, 0, 3024, 1964), rect(0, 50, 3024, 1914), 2.0, true),
            DesktopMonitor::from_tao(
                rect(1512, 0, 2560, 1440),
                rect(1512, 25, 2560, 1415),
                1.0,
                true,
            ),
        ]
    }

    #[test]
    fn mac_monitors_come_back_in_points_with_unit_content_scale() {
        let monitors = mac_pair();
        assert_eq!(monitors[0].bounds, rect(0, 0, 1512, 982));
        assert_eq!(monitors[0].work, rect(0, 25, 1512, 957));
        assert_eq!(monitors[0].content_scale, 1.0);
        // The scale-1 display's origin was multiplied by 1, so it is already
        // in points; the pair is now one continuous space.
        assert_eq!(monitors[1].bounds, rect(1512, 0, 2560, 1440));
    }

    #[test]
    fn pixel_monitors_pass_through_and_scale_content() {
        let monitor = DesktopMonitor::from_tao(
            rect(-1920, 0, 1920, 1080),
            rect(-1920, 0, 1920, 1040),
            1.5,
            false,
        );
        assert_eq!(monitor.bounds, rect(-1920, 0, 1920, 1080));
        assert_eq!(monitor.content_scale, 1.5);
        assert_eq!(logical_to_desktop(160.0, monitor.content_scale), 240);
    }

    #[test]
    fn a_broken_scale_factor_is_treated_as_one() {
        let monitor =
            DesktopMonitor::from_tao(rect(0, 0, 100, 100), rect(0, 0, 100, 100), 0.0, true);
        assert_eq!(monitor.bounds, rect(0, 0, 100, 100));
        assert_eq!(window_content_scale(f64::NAN, false), 1.0);
    }

    #[test]
    fn an_anchor_resolves_to_the_display_holding_its_centre() {
        let monitors = mac_pair();
        // A selection on the external display, in AX points.
        let anchor = rect(2000, 600, 120, 18);
        assert_eq!(monitor_for(anchor, &monitors), Some(&monitors[1]));
        // A selection straddling the seam belongs to the side of its centre.
        assert_eq!(
            monitor_for(rect(1480, 300, 100, 18), &monitors),
            Some(&monitors[1])
        );
        assert_eq!(
            monitor_for(rect(1400, 300, 100, 18), &monitors),
            Some(&monitors[0])
        );
    }

    #[test]
    fn an_off_screen_anchor_falls_back_to_the_nearest_display() {
        let monitors = mac_pair();
        assert_eq!(
            monitor_for(rect(5000, 700, 10, 10), &monitors),
            Some(&monitors[1])
        );
        assert_eq!(
            monitor_for(rect(-300, 700, 10, 10), &monitors),
            Some(&monitors[0])
        );
        assert_eq!(monitor_for(rect(0, 0, 1, 1), &[]), None);
    }

    #[test]
    fn degenerate_or_off_screen_selection_bounds_are_not_anchors() {
        let monitors = mac_pair();
        assert!(plausible_anchor(rect(400, 300, 120, 18), &monitors));
        // A caret-width rect still has height.
        assert!(plausible_anchor(rect(400, 300, 0, 18), &monitors));
        // Chromium's "no bounds" answer.
        assert!(!plausible_anchor(rect(0, 0, 0, 0), &monitors));
        assert!(!plausible_anchor(rect(400, 300, 120, 0), &monitors));
        assert!(!plausible_anchor(rect(400, 300, -5, 18), &monitors));
        // A document rect that is on no screen at all.
        assert!(!plausible_anchor(rect(9000, 9000, 120, 18), &monitors));
    }

    #[test]
    fn anchor_resolution_prefers_selection_then_pointer_then_primary_work_area() {
        let monitors = mac_pair();
        let selection = rect(400, 300, 120, 18);
        assert_eq!(
            resolve_anchor(Some(selection), Some((10, 10)), &monitors),
            selection
        );
        // Unusable bounds fall back to where the pointer last was — not to the
        // top-left corner.
        assert_eq!(
            resolve_anchor(Some(rect(0, 0, 0, 0)), Some((2100, 640)), &monitors),
            rect(2100, 640, 1, 1)
        );
        assert_eq!(
            resolve_anchor(None, Some((2100, 640)), &monitors),
            rect(2100, 640, 1, 1)
        );
        // Nothing known: the middle of the primary work area.
        assert_eq!(resolve_anchor(None, None, &monitors), rect(756, 503, 1, 1));
        assert_eq!(resolve_anchor(None, None, &[]), rect(0, 0, 1, 1));
    }

    #[test]
    fn clipping_keeps_the_visible_part_of_an_overflowing_selection() {
        let bounds = rect(0, 0, 1512, 982);
        // A selection extending above the top of the screen.
        assert_eq!(
            clip_to(rect(100, -400, 300, 600), bounds),
            rect(100, 0, 300, 200)
        );
        // Wholly on screen: unchanged.
        assert_eq!(
            clip_to(rect(100, 100, 50, 20), bounds),
            rect(100, 100, 50, 20)
        );
        // Wholly off screen: unchanged, the clamp handles it.
        assert_eq!(
            clip_to(rect(3000, 100, 50, 20), bounds),
            rect(3000, 100, 50, 20)
        );
    }

    #[test]
    fn the_cursor_comes_back_in_points_whichever_display_it_is_on() {
        // tao on macOS: the point (3000, 700) on a 1x external display, times
        // the Retina primary's scale 2.
        assert_eq!(cursor_point((6000.0, 1400.0), 2.0, true), (3000, 700));
        assert_eq!(cursor_point((800.0, 600.0), 2.0, true), (400, 300));
        // Pixels pass through; a broken scale is treated as one.
        assert_eq!(cursor_point((3000.0, 500.0), 1.5, false), (3000, 500));
        assert_eq!(cursor_point((10.0, 20.0), 0.0, true), (10, 20));
    }

    #[test]
    fn a_window_frame_on_a_retina_display_comes_back_in_points() {
        // tao: logical frame (200, 100, 180, 56) × the window's scale 2.
        assert_eq!(
            window_frame((400, 200), (360, 112), 2.0, true),
            rect(200, 100, 180, 56)
        );
        assert_eq!(
            window_frame((400, 200), (360, 112), 2.0, false),
            rect(400, 200, 360, 112)
        );
        assert_eq!(window_content_scale(2.0, true), 1.0);
        assert_eq!(window_content_scale(2.0, false), 2.0);
    }
}
