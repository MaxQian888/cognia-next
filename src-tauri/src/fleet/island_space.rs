//! Space / full-screen awareness for the island overlay.
//!
//! ## Why this exists
//!
//! The island anchors to the **full monitor frame** rather than the work area
//! precisely because `NSScreen.visibleFrame` is Space-dependent
//! (`island_window.rs`). But "is the menu bar occupying the top strip right
//! now" is exactly the question the island *does* need answered — not as an
//! anchor, as a **signal**: on a full-screen Space the top strip belongs to the
//! app, and an idle status pill camping there is noise at best and a click
//! shadow at worst.
//!
//! So the same quantity gets used the other way around: the frame-vs-work-area
//! delta is a free, allocation-less "menu bar is hidden" probe, and only when
//! it flips do we pay for a `CGWindowListCopyWindowInfo` sweep to distinguish a
//! genuine full-screen Space from a user who simply auto-hides their menu bar.
//!
//! ## Why polling and not `NSWorkspaceActiveSpaceDidChangeNotification`
//!
//! Registering an AppKit notification observer from Rust needs a block or a
//! declared ObjC class plus another `objc2-app-kit` feature, and a missed
//! notification leaves the island stuck in the wrong regime forever. The island
//! already runs exactly one single-flight polling task (the cursor hover
//! monitor in `island_window.rs`), so the geometry sample rides along on it at
//! a coarser cadence. Polling is self-healing: every tick re-derives the truth
//! from scratch, so there is no state to get stranded.
//!
//! The layering mirrors `pet_window/surfaces.rs`: pure predicates over plain
//! records (unit-tested here) sit above a thin platform query that can only be
//! smoke-tested on a live desktop.

/// A physical-pixel rectangle in global top-left-origin coordinates — the space
/// `tauri::Monitor` positions and (after scaling) `CGWindowBounds` both live in.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Rect {
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

/// Slack (physical px at 1x, scaled by the caller) allowed on the left/right/
/// bottom edges when deciding whether a window covers a display. Full-screen
/// windows match their display exactly; the slack only absorbs rounding.
const EDGE_SLACK: f64 = 2.0;

/// Slack allowed on the **top** edge specifically. Generous because macOS
/// places a full-screen app's content *below* the camera housing on notched
/// displays, so a legitimately full-screen window's top edge can sit a whole
/// notch height below the frame top. 44 logical px comfortably clears every
/// shipped notch (the tallest is ~37) without reaching a window that merely
/// starts under a normal title bar.
const TOP_SLACK_LOGICAL: f64 = 44.0;

/// Minimum delta (logical px) between the frame top and the work-area top for
/// the menu bar to count as present. The menu bar is ~24–38 pt tall; anything
/// smaller is rounding noise.
const MENU_BAR_MIN_LOGICAL: f64 = 8.0;

/// Is the menu bar currently occupying the top strip of this display?
///
/// `frame_y` / `work_y` are the display frame's and work area's top edges in
/// physical pixels; `scale` converts the logical threshold. Pure.
pub(crate) fn menu_bar_occupies_top(frame_y: f64, work_y: f64, scale: f64) -> bool {
    let scale = if scale > 0.0 { scale } else { 1.0 };
    work_y - frame_y >= MENU_BAR_MIN_LOGICAL * scale
}

/// Does `bounds` cover `frame` the way a full-screen window does?
///
/// Full width and reaching the very bottom (a full-screen Space hides the Dock
/// too) are required exactly; the top edge is allowed a notch's worth of slack.
/// A maximized ("zoomed") window fails this — it stops at the work area, so its
/// bottom sits above the Dock and its top below the menu bar. Pure.
pub(crate) fn bounds_covers_frame(bounds: Rect, frame: Rect, scale: f64) -> bool {
    let scale = if scale > 0.0 { scale } else { 1.0 };
    let edge = EDGE_SLACK * scale;
    let top = TOP_SLACK_LOGICAL * scale;
    bounds.x <= frame.x + edge
        && bounds.right() >= frame.right() - edge
        && bounds.y <= frame.y + top
        && bounds.bottom() >= frame.bottom() - edge
}

/// Decide the full-screen verdict from an already-collected candidate list.
///
/// `candidates` are `(rect, is_foreign_app_window)` pairs — the caller has
/// already excluded our own windows and non-app layers. Split out from the
/// platform query so the decision is unit-testable. Pure.
pub(crate) fn any_candidate_covers(candidates: &[(Rect, bool)], frame: Rect, scale: f64) -> bool {
    candidates
        .iter()
        .any(|(rect, eligible)| *eligible && bounds_covers_frame(*rect, frame, scale))
}

/// Is a full-screen app currently occupying `frame` on this display?
///
/// Two-stage by design: the free menu-bar probe short-circuits the common case
/// (menu bar visible ⇒ not a full-screen Space) so the expensive window sweep
/// only runs when the top strip is already unclaimed.
#[cfg(target_os = "macos")]
pub(crate) fn display_is_fullscreen(frame: Rect, work_y: f64, scale: f64) -> bool {
    if menu_bar_occupies_top(frame.y, work_y, scale) {
        return false;
    }
    // Menu bar is hidden — either a full-screen Space or a user who auto-hides
    // it. Only a window actually covering the whole frame settles it.
    let candidates: Vec<(Rect, bool)> = crate::pet_window::enumerate_scaled_candidates(scale)
        .into_iter()
        .map(|c| {
            let rect = Rect {
                x: c.left as f64,
                y: c.top as f64,
                w: (c.right - c.left) as f64,
                h: (c.bottom - c.top) as f64,
            };
            // `tool_window` is `layer != 0` on macOS — menu bar, Dock, and every
            // other system chrome window. Only real app windows (layer 0) can
            // put a display into a full-screen Space. Our own windows are
            // already dropped by owner-PID inside the platform enumeration.
            let eligible = !c.tool_window && c.visible && !c.minimized;
            (rect, eligible)
        })
        .collect();
    any_candidate_covers(&candidates, frame, scale)
}

/// Non-macOS: Windows and Linux keep the island on the work area, which is
/// already taskbar/panel-aware, and neither platform has the Space model this
/// guards against.
#[cfg(not(target_os = "macos"))]
pub(crate) fn display_is_fullscreen(_frame: Rect, _work_y: f64, _scale: f64) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 1512×982 logical display at 2x — a 14" MacBook Pro.
    const FRAME: Rect = Rect {
        x: 0.0,
        y: 0.0,
        w: 3024.0,
        h: 1964.0,
    };
    const SCALE: f64 = 2.0;
    /// Work-area top on a normal Space: below the 38pt menu bar.
    const WORK_Y_NORMAL: f64 = 76.0;

    #[test]
    fn menu_bar_probe_separates_normal_from_hidden() {
        assert!(menu_bar_occupies_top(FRAME.y, WORK_Y_NORMAL, SCALE));
        // Full-screen Space: work area starts at the frame top.
        assert!(!menu_bar_occupies_top(FRAME.y, 0.0, SCALE));
        // Sub-threshold delta is rounding noise, not a menu bar.
        assert!(!menu_bar_occupies_top(FRAME.y, 4.0, SCALE));
        // Secondary monitor with a non-zero origin.
        assert!(menu_bar_occupies_top(1080.0, 1156.0, SCALE));
        assert!(!menu_bar_occupies_top(1080.0, 1080.0, SCALE));
        // Degenerate scale can't panic or divide.
        assert!(menu_bar_occupies_top(0.0, 100.0, 0.0));
    }

    #[test]
    fn fullscreen_window_covers_the_frame() {
        let fullscreen = Rect {
            x: 0.0,
            y: 0.0,
            w: 3024.0,
            h: 1964.0,
        };
        assert!(bounds_covers_frame(fullscreen, FRAME, SCALE));
    }

    #[test]
    fn notched_fullscreen_starts_below_the_camera_housing() {
        // macOS pushes full-screen content below the notch (37 logical = 74
        // physical) — still full-screen.
        let below_notch = Rect {
            x: 0.0,
            y: 74.0,
            w: 3024.0,
            h: 1890.0,
        };
        assert!(bounds_covers_frame(below_notch, FRAME, SCALE));
    }

    #[test]
    fn maximized_window_is_not_fullscreen() {
        // Zoomed to the work area: below the menu bar, above the Dock.
        let maximized = Rect {
            x: 0.0,
            y: 76.0,
            w: 3024.0,
            h: 1764.0,
        };
        assert!(!bounds_covers_frame(maximized, FRAME, SCALE));
    }

    #[test]
    fn narrow_or_offset_windows_are_not_fullscreen() {
        // Half-width.
        assert!(!bounds_covers_frame(
            Rect {
                x: 0.0,
                y: 0.0,
                w: 1512.0,
                h: 1964.0
            },
            FRAME,
            SCALE
        ));
        // Full size but on the neighbouring display.
        assert!(!bounds_covers_frame(
            Rect {
                x: 3024.0,
                y: 0.0,
                w: 3024.0,
                h: 1964.0
            },
            FRAME,
            SCALE
        ));
        // Top edge just past the notch slack (45 logical = 90 physical).
        assert!(!bounds_covers_frame(
            Rect {
                x: 0.0,
                y: 90.0,
                w: 3024.0,
                h: 1874.0
            },
            FRAME,
            SCALE
        ));
    }

    #[test]
    fn rounding_slack_is_tolerated_on_the_edges() {
        let off_by_one = Rect {
            x: 1.0,
            y: 0.0,
            w: 3022.0,
            h: 1963.0,
        };
        assert!(bounds_covers_frame(off_by_one, FRAME, SCALE));
    }

    #[test]
    fn only_eligible_candidates_can_trigger_the_verdict() {
        let covering = Rect {
            x: 0.0,
            y: 0.0,
            w: 3024.0,
            h: 1964.0,
        };
        // Ineligible (system chrome / hidden) windows are ignored even when
        // they span the display — the menu bar itself spans the full width.
        assert!(!any_candidate_covers(&[(covering, false)], FRAME, SCALE));
        assert!(any_candidate_covers(&[(covering, true)], FRAME, SCALE));
        // Mixed list: the eligible one decides.
        assert!(any_candidate_covers(
            &[
                (
                    Rect {
                        x: 0.0,
                        y: 200.0,
                        w: 800.0,
                        h: 600.0
                    },
                    true
                ),
                (covering, true),
            ],
            FRAME,
            SCALE
        ));
        assert!(!any_candidate_covers(&[], FRAME, SCALE));
    }

    #[test]
    fn rect_edges_are_derived_not_stored() {
        let r = Rect {
            x: 10.0,
            y: 20.0,
            w: 100.0,
            h: 50.0,
        };
        assert_eq!(r.right(), 110.0);
        assert_eq!(r.bottom(), 70.0);
    }

    /// The platform query must never claim full-screen while the menu bar is
    /// visible — that short-circuit is what keeps the expensive sweep off the
    /// hot path, so it is pinned rather than left to the reader.
    #[test]
    fn platform_query_short_circuits_when_the_menu_bar_is_visible() {
        assert!(!display_is_fullscreen(FRAME, WORK_Y_NORMAL, SCALE));
    }
}
