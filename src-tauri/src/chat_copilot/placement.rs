//! Where the chat copilot panel goes (ADR-0194 §8). Pure, so the contract is
//! unit-tested on every platform rather than only smoke-tested on a packaged
//! app.
//!
//! The panel sits BESIDE the captured chat window, never on top of the
//! conversation it is reading: right of it when that fits the work area, left
//! of it otherwise, and only as a last resort over the window's right edge
//! (a maximized chat leaves nowhere else). With no window known yet (the
//! capture is still asking for consent), it waits at the top-right corner of
//! the screen under the cursor.
//!
//! Everything is computed in desktop units (`desktop_space`): points on
//! macOS, physical pixels elsewhere. tao's "physical" monitor rects are not
//! one continuous space on macOS (each display's points times its OWN scale),
//! so mixing them with the anchor put the panel on the wrong display, or at
//! the wrong spot on the right one, whenever a Retina laptop and a 1x
//! external display were both attached.

use crate::automation::platform::shared::desktop_space::{self, DesktopMonitor};
use crate::automation::types::Rect as DesktopRect;
use serde::{Deserialize, Serialize};

/// The captured window in global logical points, plus its pixels-per-point.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Anchor {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale: f64,
}

impl Anchor {
    /// Finite, non-empty and a plausible scale. The renderer relays what the
    /// automation engine measured; a malformed one must not move a window.
    pub fn is_valid(&self) -> bool {
        [self.x, self.y, self.width, self.height, self.scale]
            .iter()
            .all(|v| v.is_finite())
            && self.width > 0.0
            && self.height > 0.0
            && self.scale > 0.0
            && self.scale <= 8.0
    }
}

/// A rectangle in desktop units.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    pub fn right(&self) -> f64 {
        self.x + self.w
    }

    pub fn bottom(&self) -> f64 {
        self.y + self.h
    }
}

/// Logical gap between the chat window and the panel.
pub const GAP: f64 = 12.0;
/// Logical margin kept from the work-area edges.
pub const MARGIN: f64 = 16.0;

/// The anchor in desktop units. The automation engine reports the captured
/// window in logical points on every platform: on macOS those already are
/// desktop units; elsewhere they are the capture's physical pixels divided by
/// the capture's own scale, so multiplying by that same scale (not the scale
/// of whichever monitor a lookup happens to find) recovers the pixels.
pub fn to_desktop(anchor: &Anchor, units_are_points: bool) -> Rect {
    let scale = if units_are_points { 1.0 } else { anchor.scale };
    Rect {
        x: anchor.x * scale,
        y: anchor.y * scale,
        w: anchor.width * scale,
        h: anchor.height * scale,
    }
}

/// What the panel is placed against, in desktop units.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Target {
    /// The captured chat window.
    Window(Rect),
    /// No window known yet: the screen under the cursor, or the primary
    /// display when the cursor position is unavailable.
    Cursor(Option<(f64, f64)>),
}

/// The display the panel goes on: its work area, and desktop units per
/// logical (CSS) pixel there.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Display {
    pub area: Rect,
    pub content_scale: f64,
}

/// Used only when no display is reported at all (headless, shutdown).
const FALLBACK_DISPLAY: Display = Display {
    area: Rect {
        x: 0.0,
        y: 0.0,
        w: 1920.0,
        h: 1080.0,
    },
    content_scale: 1.0,
};

fn desktop_rect(rect: Rect) -> DesktopRect {
    DesktopRect {
        x: rect.x.round() as i32,
        y: rect.y.round() as i32,
        width: rect.w.round() as i32,
        height: rect.h.round() as i32,
    }
}

fn display_of(monitor: &DesktopMonitor) -> Display {
    let work = monitor.work;
    Display {
        area: Rect {
            x: f64::from(work.x),
            y: f64::from(work.y),
            w: f64::from(work.width),
            h: f64::from(work.height),
        },
        content_scale: monitor.content_scale,
    }
}

/// The display holding `target` (or the nearest one), from `monitors` in
/// desktop units with the primary display first.
pub fn display_for(target: Target, monitors: &[DesktopMonitor]) -> Display {
    let monitor = match target {
        Target::Window(rect) => desktop_space::monitor_for(desktop_rect(rect), monitors),
        Target::Cursor(Some((x, y))) => desktop_space::monitor_for(
            desktop_rect(Rect {
                x,
                y,
                w: 1.0,
                h: 1.0,
            }),
            monitors,
        ),
        Target::Cursor(None) => monitors.first(),
    };
    monitor.map(display_of).unwrap_or(FALLBACK_DISPLAY)
}

/// A renderer-measured size (logical px) in desktop units on the target's
/// display, kept inside its work area.
pub fn fit(target: Target, logical: (f64, f64), monitors: &[DesktopMonitor]) -> (f64, f64) {
    let display = display_for(target, monitors);
    let scale = display.content_scale;
    clamp_size(
        (logical.0 * scale, logical.1 * scale),
        display.area,
        MARGIN * scale,
    )
}

/// Top-left (desktop units) for a `panel` (desktop units) against `target`.
pub fn position(target: Target, panel: (f64, f64), monitors: &[DesktopMonitor]) -> (f64, f64) {
    let display = display_for(target, monitors);
    let scale = display.content_scale;
    match target {
        Target::Window(window) => {
            place_beside(window, panel, display.area, GAP * scale, MARGIN * scale)
        }
        Target::Cursor(_) => place_default(panel, display.area, MARGIN * scale),
    }
}

fn clamp_axis(value: f64, min: f64, max: f64) -> f64 {
    if max < min {
        min
    } else {
        value.clamp(min, max)
    }
}

/// Top-left for a `panel` (w, h) beside `target`, inside `area`.
pub fn place_beside(
    target: Rect,
    panel: (f64, f64),
    area: Rect,
    gap: f64,
    margin: f64,
) -> (f64, f64) {
    let (w, h) = panel;
    let min_x = area.x + margin;
    let max_x = area.right() - margin - w;
    let right = target.right() + gap;
    let left = target.x - gap - w;
    let x = if right <= max_x {
        right
    } else if left >= min_x {
        left
    } else {
        // No room on either side: overlap the window's right edge, which is
        // where a chat app keeps the least of the conversation.
        clamp_axis(target.right() - margin - w, min_x, max_x)
    };
    let y = clamp_axis(target.y, area.y + margin, area.bottom() - margin - h);
    (x, y)
}

/// Top-left for a `panel` waiting at the top-right of `area`.
pub fn place_default(panel: (f64, f64), area: Rect, margin: f64) -> (f64, f64) {
    (
        clamp_axis(
            area.right() - margin - panel.0,
            area.x + margin,
            area.right(),
        ),
        area.y + margin,
    )
}

/// Keep a measured size inside the work area.
pub fn clamp_size(size: (f64, f64), area: Rect, margin: f64) -> (f64, f64) {
    let max_w = (area.w - 2.0 * margin).max(1.0);
    let max_h = (area.h - 2.0 * margin).max(1.0);
    (size.0.clamp(1.0, max_w), size.1.clamp(1.0, max_h))
}

#[cfg(test)]
mod tests {
    use super::*;

    const AREA: Rect = Rect {
        x: 0.0,
        y: 50.0,
        w: 3000.0,
        h: 1800.0,
    };
    const PANEL: (f64, f64) = (760.0, 900.0);

    #[test]
    fn validates_the_anchor_the_renderer_relays() {
        let ok = Anchor {
            x: 100.0,
            y: 50.0,
            width: 500.0,
            height: 400.0,
            scale: 2.0,
        };
        assert!(ok.is_valid());
        assert!(!Anchor { width: 0.0, ..ok }.is_valid());
        assert!(!Anchor { x: f64::NAN, ..ok }.is_valid());
        assert!(!Anchor { scale: 0.0, ..ok }.is_valid());
        assert!(!Anchor { scale: 40.0, ..ok }.is_valid());
        // Points are desktop units on macOS; elsewhere the capture's own
        // scale turns them back into pixels.
        assert_eq!(
            to_desktop(&ok, true),
            Rect {
                x: 100.0,
                y: 50.0,
                w: 500.0,
                h: 400.0
            }
        );
        assert_eq!(
            to_desktop(&ok, false),
            Rect {
                x: 200.0,
                y: 100.0,
                w: 1000.0,
                h: 800.0
            }
        );
    }

    #[test]
    fn prefers_the_right_of_the_chat_window() {
        let chat = Rect {
            x: 200.0,
            y: 300.0,
            w: 1200.0,
            h: 1000.0,
        };
        assert_eq!(place_beside(chat, PANEL, AREA, 24.0, 32.0), (1424.0, 300.0));
    }

    #[test]
    fn falls_back_to_the_left_when_the_right_is_full() {
        let chat = Rect {
            x: 1400.0,
            y: 300.0,
            w: 1500.0,
            h: 1000.0,
        };
        assert_eq!(place_beside(chat, PANEL, AREA, 24.0, 32.0), (616.0, 300.0));
    }

    #[test]
    fn overlaps_the_right_edge_of_a_maximized_chat_as_a_last_resort() {
        let chat = Rect {
            x: 0.0,
            y: 50.0,
            w: 3000.0,
            h: 1800.0,
        };
        let (x, y) = place_beside(chat, PANEL, AREA, 24.0, 32.0);
        assert_eq!(x, 3000.0 - 32.0 - 760.0);
        // Kept inside the work area vertically.
        assert_eq!(y, 50.0 + 32.0);
    }

    #[test]
    fn keeps_a_low_window_s_panel_on_screen() {
        let chat = Rect {
            x: 200.0,
            y: 1500.0,
            w: 800.0,
            h: 300.0,
        };
        let (_, y) = place_beside(chat, PANEL, AREA, 24.0, 32.0);
        assert_eq!(y, 1850.0 - 32.0 - 900.0);
    }

    #[test]
    fn waits_top_right_without_a_window() {
        assert_eq!(
            place_default(PANEL, AREA, 32.0),
            (3000.0 - 32.0 - 760.0, 82.0)
        );
    }

    #[test]
    fn clamps_a_measured_size_to_the_work_area() {
        assert_eq!(clamp_size((760.0, 4000.0), AREA, 32.0), (760.0, 1736.0));
        assert_eq!(clamp_size((0.0, -5.0), AREA, 32.0), (1.0, 1.0));
    }

    fn drect(x: i32, y: i32, width: i32, height: i32) -> DesktopRect {
        DesktopRect {
            x,
            y,
            width,
            height,
        }
    }

    /// A 1512×982pt Retina laptop (scale 2, primary) and a 2560×1440pt 1x
    /// display to its right, as tao reports them on macOS.
    fn mac_pair() -> Vec<DesktopMonitor> {
        vec![
            DesktopMonitor::from_tao(drect(0, 0, 3024, 1964), drect(0, 50, 3024, 1914), 2.0, true),
            DesktopMonitor::from_tao(
                drect(1512, 0, 2560, 1440),
                drect(1512, 25, 2560, 1415),
                1.0,
                true,
            ),
        ]
    }

    /// A 150% laptop (primary) and a 1x display to its right, as tao reports
    /// them on Windows: already physical pixels.
    fn windows_pair() -> Vec<DesktopMonitor> {
        vec![
            DesktopMonitor::from_tao(drect(0, 0, 2880, 1800), drect(0, 0, 2880, 1728), 1.5, false),
            DesktopMonitor::from_tao(
                drect(2880, 0, 1920, 1080),
                drect(2880, 0, 1920, 1040),
                1.0,
                false,
            ),
        ]
    }

    fn mac_anchor(x: f64, y: f64, width: f64, height: f64, scale: f64) -> Target {
        Target::Window(to_desktop(
            &Anchor {
                x,
                y,
                width,
                height,
                scale,
            },
            true,
        ))
    }

    #[test]
    fn a_chat_on_the_1x_external_display_gets_the_panel_beside_it_in_points() {
        let monitors = mac_pair();
        let target = mac_anchor(2000.0, 200.0, 800.0, 600.0, 1.0);
        assert_eq!(
            display_for(target, &monitors).area,
            Rect {
                x: 1512.0,
                y: 25.0,
                w: 2560.0,
                h: 1415.0
            }
        );
        let panel = fit(target, (380.0, 240.0), &monitors);
        // Points: the panel's logical size is its size in desktop units.
        assert_eq!(panel, (380.0, 240.0));
        assert_eq!(position(target, panel, &monitors), (2812.0, 200.0));
    }

    #[test]
    fn a_chat_on_the_retina_laptop_is_not_scaled_by_its_backing_factor() {
        let monitors = mac_pair();
        let target = mac_anchor(100.0, 100.0, 600.0, 500.0, 2.0);
        let display = display_for(target, &monitors);
        // tao's (0, 50, 3024, 1914) work area, back in points.
        assert_eq!(
            display.area,
            Rect {
                x: 0.0,
                y: 25.0,
                w: 1512.0,
                h: 957.0
            }
        );
        assert_eq!(display.content_scale, 1.0);
        // Right of the window by the logical gap, not twice it, and not at
        // twice the window's coordinates.
        assert_eq!(
            position(target, (380.0, 240.0), &monitors),
            (100.0 + 600.0 + GAP, 100.0)
        );
    }

    #[test]
    fn a_chat_straddling_the_seam_uses_the_display_holding_its_centre() {
        let monitors = mac_pair();
        // Centre at x = 1562: on the external display, so the panel goes
        // right of the window there.
        let target = mac_anchor(1200.0, 300.0, 724.0, 500.0, 2.0);
        assert_eq!(display_for(target, &monitors).area.x, 1512.0);
        assert_eq!(
            position(target, (380.0, 240.0), &monitors),
            (1924.0 + GAP, 300.0)
        );
    }

    #[test]
    fn a_tall_result_is_clamped_to_the_retina_work_area_in_points() {
        let monitors = mac_pair();
        let target = mac_anchor(100.0, 100.0, 600.0, 500.0, 2.0);
        assert_eq!(
            fit(target, (380.0, 2000.0), &monitors),
            (380.0, 957.0 - 2.0 * MARGIN)
        );
    }

    #[test]
    fn the_cursor_on_the_external_display_picks_that_display_on_macos() {
        let monitors = mac_pair();
        // Where `desktop_space::cursor_point` puts tao's (6000, 1400) with a
        // scale-2 primary display.
        let target = Target::Cursor(Some((3000.0, 700.0)));
        let panel = fit(target, (380.0, 240.0), &monitors);
        assert_eq!(
            position(target, panel, &monitors),
            (1512.0 + 2560.0 - MARGIN - 380.0, 25.0 + MARGIN)
        );
    }

    #[test]
    fn the_cursor_on_the_retina_laptop_waits_at_its_top_right() {
        let monitors = mac_pair();
        let target = Target::Cursor(Some((400.0, 300.0)));
        assert_eq!(
            position(target, (380.0, 240.0), &monitors),
            (1512.0 - MARGIN - 380.0, 25.0 + MARGIN)
        );
    }

    #[test]
    fn an_unknown_cursor_waits_on_the_primary_display() {
        let monitors = mac_pair();
        assert_eq!(
            position(Target::Cursor(None), (380.0, 240.0), &monitors),
            (1512.0 - MARGIN - 380.0, 25.0 + MARGIN)
        );
    }

    #[test]
    fn pixel_platforms_scale_the_anchor_by_its_capture_and_the_panel_by_its_display() {
        let monitors = windows_pair();
        // The capture on the 150% laptop: logical = pixels / 1.5.
        let target = Target::Window(to_desktop(
            &Anchor {
                x: 100.0,
                y: 100.0,
                width: 600.0,
                height: 400.0,
                scale: 1.5,
            },
            false,
        ));
        let panel = fit(target, (380.0, 240.0), &monitors);
        assert_eq!(panel, (570.0, 360.0));
        assert_eq!(
            position(target, panel, &monitors),
            (150.0 + 900.0 + GAP * 1.5, 150.0)
        );
        let target = Target::Cursor(Some((3000.0, 500.0)));
        let panel = fit(target, (380.0, 240.0), &monitors);
        assert_eq!(panel, (380.0, 240.0));
        assert_eq!(
            position(target, panel, &monitors),
            (2880.0 + 1920.0 - MARGIN - 380.0, MARGIN)
        );
    }

    #[test]
    fn no_reported_display_falls_back_to_a_plain_1080p_area() {
        assert_eq!(display_for(Target::Cursor(None), &[]), FALLBACK_DISPLAY);
    }
}
