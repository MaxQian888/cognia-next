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

    pub fn center(&self) -> (f64, f64) {
        (self.x + self.width / 2.0, self.y + self.height / 2.0)
    }
}

/// A rectangle in physical pixels.
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

    pub fn contains(&self, (px, py): (f64, f64)) -> bool {
        px >= self.x && px < self.right() && py >= self.y && py < self.bottom()
    }
}

/// Logical gap between the chat window and the panel.
pub const GAP: f64 = 12.0;
/// Logical margin kept from the work-area edges.
pub const MARGIN: f64 = 16.0;

/// The anchor in physical pixels at the scale of the monitor it is on.
pub fn to_physical(anchor: &Anchor, scale: f64) -> Rect {
    Rect {
        x: anchor.x * scale,
        y: anchor.y * scale,
        w: anchor.width * scale,
        h: anchor.height * scale,
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
        assert_eq!(ok.center(), (350.0, 250.0));
        assert_eq!(
            to_physical(&ok, 2.0),
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

    #[test]
    fn rect_contains_is_half_open() {
        assert!(AREA.contains((0.0, 50.0)));
        assert!(!AREA.contains((3000.0, 100.0)));
    }
}
