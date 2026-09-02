//! Pure geometry for the Capacity Dock (ADR-0165).
//!
//! Everything here is a function of numbers, with no Tauri handle and no
//! AppKit, so the whole placement contract is unit-tested on every platform
//! rather than only smoke-tested on a packaged app. That split matters more
//! here than for the island: the dock can live on any of four edges, on any
//! monitor, at any along-edge offset, and CodeBurn's own notes report a 5-7%
//! idle relayout failure that traces back to fractional pixel drift. Every
//! value this module returns is pixel-aligned for exactly that reason.

use serde::{Deserialize, Serialize};

/// Which screen edge the dock is docked to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum DockEdge {
    Left,
    #[default]
    Right,
    Top,
    Bottom,
    /// Not docked. The dock keeps an absolute position the user dragged it to.
    Floating,
}

impl DockEdge {
    /// True when the rail runs vertically, i.e. its long axis is Y.
    pub fn is_vertical(self) -> bool {
        matches!(self, DockEdge::Left | DockEdge::Right)
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

/// How close to an edge a drag has to end for the dock to snap to it.
pub const SNAP_THRESHOLD_PX: f64 = 44.0;

/// Scale bounds the renderer and the settings card both clamp to.
pub const MIN_SCALE: f64 = 0.6;
pub const MAX_SCALE: f64 = 1.2;

/// Rows the expanded rail will render. More than this and the rail stops being
/// a glance and starts being a window the user has to read.
pub const MAX_VISIBLE_ROWS: usize = 5;

/// Round to a whole physical pixel.
///
/// A window positioned on a fractional pixel is composited with a half-pixel
/// blur, and on a scale-factor change the accumulated error is what makes a
/// rail drift a little further from its edge on every relayout. Snapping every
/// coordinate here means the drift has nowhere to accumulate.
pub fn align(v: f64) -> f64 {
    if v.is_finite() {
        v.round()
    } else {
        0.0
    }
}

/// Clamp a user scale into the supported range, rejecting a non-finite value.
pub fn clamp_scale(scale: f64) -> f64 {
    if !scale.is_finite() {
        return 1.0;
    }
    scale.clamp(MIN_SCALE, MAX_SCALE)
}

/// Clamp the rail's size to the work area, so an expanded dock can never spill
/// off screen and paint a scrollbar.
pub fn clamp_size(size: (f64, f64), area: Rect) -> (f64, f64) {
    let w = align(size.0.min(area.w).max(1.0));
    let h = align(size.1.min(area.h).max(1.0));
    (w, h)
}

/// Position the rail against an edge of `area`.
///
/// `offset` is the normalized position along the edge, 0.0 at the top/left end
/// and 1.0 at the bottom/right end. It is normalized rather than absolute so
/// the dock lands in the same visual place after a resolution change, which an
/// absolute pixel offset cannot do.
pub fn resolve_position(edge: DockEdge, area: Rect, size: (f64, f64), offset: f64) -> (f64, f64) {
    let (w, h) = clamp_size(size, area);
    let t = if offset.is_finite() {
        offset.clamp(0.0, 1.0)
    } else {
        0.5
    };
    let along_x = area.x + (area.w - w) * t;
    let along_y = area.y + (area.h - h) * t;
    let (x, y) = match edge {
        DockEdge::Left => (area.x, along_y),
        DockEdge::Right => (area.x + area.w - w, along_y),
        DockEdge::Top => (along_x, area.y),
        DockEdge::Bottom => (along_x, area.y + area.h - h),
        // A floating dock keeps whatever offset pair the caller stored, which
        // `resolve_floating_position` handles. Landing here means the caller
        // asked for an edge placement on a floating dock, so centre it rather
        // than pinning it to a corner it never chose.
        DockEdge::Floating => (area.x + (area.w - w) / 2.0, area.y + (area.h - h) / 2.0),
    };
    (align(x), align(y))
}

/// Keep a floating dock fully inside the work area after a monitor change.
pub fn resolve_floating_position(area: Rect, size: (f64, f64), desired: (f64, f64)) -> (f64, f64) {
    let (w, h) = clamp_size(size, area);
    let x = desired.0.clamp(area.x, (area.x + area.w - w).max(area.x));
    let y = desired.1.clamp(area.y, (area.y + area.h - h).max(area.y));
    (align(x), align(y))
}

/// Normalized along-edge offset a window at `pos` currently sits at.
///
/// The inverse of [`resolve_position`], used after a drag so the stored offset
/// describes where the user actually let go.
pub fn offset_from_position(edge: DockEdge, area: Rect, size: (f64, f64), pos: (f64, f64)) -> f64 {
    let (w, h) = clamp_size(size, area);
    let (travel, delta) = if edge.is_vertical() {
        (area.h - h, pos.1 - area.y)
    } else {
        (area.w - w, pos.0 - area.x)
    };
    if travel <= 0.0 {
        return 0.0;
    }
    (delta / travel).clamp(0.0, 1.0)
}

/// The edge a drag ending at `pos` should snap to, or `Floating` when the
/// release point is not near any edge.
///
/// Ties are broken toward the nearest edge, and a window smaller than the
/// threshold in both axes still resolves to one edge rather than oscillating,
/// because the comparison is on distance and never on a boolean per edge.
pub fn snap_edge(area: Rect, size: (f64, f64), pos: (f64, f64)) -> DockEdge {
    let (w, h) = clamp_size(size, area);
    let candidates = [
        (DockEdge::Left, pos.0 - area.x),
        (DockEdge::Right, (area.x + area.w) - (pos.0 + w)),
        (DockEdge::Top, pos.1 - area.y),
        (DockEdge::Bottom, (area.y + area.h) - (pos.1 + h)),
    ];
    let mut best: Option<(DockEdge, f64)> = None;
    for (edge, distance) in candidates {
        if distance > SNAP_THRESHOLD_PX {
            continue;
        }
        let distance = distance.max(0.0);
        match best {
            Some((_, d)) if d <= distance => {}
            _ => best = Some((edge, distance)),
        }
    }
    best.map(|(edge, _)| edge).unwrap_or(DockEdge::Floating)
}

/// Whether a global cursor point is inside a window rect. Half-open on the far
/// edges, so two rails touching at a boundary can never both claim the cursor.
pub fn point_in_rect(point: (f64, f64), origin: (f64, f64), size: (f64, f64)) -> bool {
    point.0 >= origin.0
        && point.0 < origin.0 + size.0
        && point.1 >= origin.1
        && point.1 < origin.1 + size.1
}

/// Logical size of the rail for a row count and user scale.
///
/// The collapsed rail shows one row. Expanding grows only along the long axis,
/// so the rail never encroaches further into the screen than the user's chosen
/// thickness, which is the property that makes an edge rail feel docked rather
/// than like a floating window that happens to be near an edge.
pub fn rail_size(edge: DockEdge, rows: usize, scale: f64) -> (f64, f64) {
    const ROW: f64 = 34.0;
    const THICKNESS: f64 = 56.0;
    const PADDING: f64 = 8.0;
    let scale = clamp_scale(scale);
    let rows = rows.clamp(1, MAX_VISIBLE_ROWS) as f64;
    let long = (ROW * rows + PADDING) * scale;
    let short = THICKNESS * scale;
    if edge.is_vertical() || edge == DockEdge::Floating {
        (align(short), align(long))
    } else {
        (align(long), align(short))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const AREA: Rect = Rect {
        x: 0.0,
        y: 0.0,
        w: 1920.0,
        h: 1080.0,
    };
    const SIZE: (f64, f64) = (60.0, 200.0);

    #[test]
    fn align_snaps_to_whole_pixels_and_survives_nonsense() {
        assert_eq!(align(10.4), 10.0);
        assert_eq!(align(10.6), 11.0);
        assert_eq!(align(f64::NAN), 0.0);
        assert_eq!(align(f64::INFINITY), 0.0);
    }

    #[test]
    fn clamp_scale_bounds_and_defaults() {
        assert_eq!(clamp_scale(0.1), MIN_SCALE);
        assert_eq!(clamp_scale(9.0), MAX_SCALE);
        assert_eq!(clamp_scale(1.0), 1.0);
        assert_eq!(clamp_scale(f64::NAN), 1.0);
    }

    #[test]
    fn clamp_size_never_exceeds_the_work_area() {
        let (w, h) = clamp_size((9999.0, 9999.0), AREA);
        assert_eq!((w, h), (1920.0, 1080.0));
    }

    #[test]
    fn clamp_size_never_collapses_to_zero() {
        let (w, h) = clamp_size((0.0, -5.0), AREA);
        assert!(w >= 1.0 && h >= 1.0);
    }

    #[test]
    fn left_edge_hugs_the_left_and_right_edge_hugs_the_right() {
        assert_eq!(resolve_position(DockEdge::Left, AREA, SIZE, 0.5).0, 0.0);
        assert_eq!(
            resolve_position(DockEdge::Right, AREA, SIZE, 0.5).0,
            1920.0 - 60.0
        );
    }

    #[test]
    fn top_edge_hugs_the_top_and_bottom_edge_hugs_the_bottom() {
        assert_eq!(
            resolve_position(DockEdge::Top, AREA, (200.0, 60.0), 0.5).1,
            0.0
        );
        assert_eq!(
            resolve_position(DockEdge::Bottom, AREA, (200.0, 60.0), 0.5).1,
            1080.0 - 60.0
        );
    }

    #[test]
    fn offset_zero_and_one_reach_both_ends_of_the_edge() {
        assert_eq!(resolve_position(DockEdge::Right, AREA, SIZE, 0.0).1, 0.0);
        assert_eq!(
            resolve_position(DockEdge::Right, AREA, SIZE, 1.0).1,
            1080.0 - 200.0
        );
    }

    #[test]
    fn placement_respects_a_work_area_that_does_not_start_at_the_origin() {
        // A second monitor to the right of the primary, with a taskbar.
        let area = Rect {
            x: 1920.0,
            y: 40.0,
            w: 1280.0,
            h: 960.0,
        };
        let (x, y) = resolve_position(DockEdge::Left, area, SIZE, 0.0);
        assert_eq!((x, y), (1920.0, 40.0));
    }

    #[test]
    fn a_nonsense_offset_centres_rather_than_throwing_the_rail_off_screen() {
        let (_, y) = resolve_position(DockEdge::Right, AREA, SIZE, f64::NAN);
        assert_eq!(y, (1080.0 - 200.0) / 2.0);
    }

    #[test]
    fn an_out_of_range_offset_is_clamped_to_the_edge() {
        assert_eq!(resolve_position(DockEdge::Right, AREA, SIZE, -5.0).1, 0.0);
        assert_eq!(
            resolve_position(DockEdge::Right, AREA, SIZE, 5.0).1,
            1080.0 - 200.0
        );
    }

    #[test]
    fn every_placement_lands_on_a_whole_pixel() {
        let area = Rect {
            x: 0.5,
            y: 0.5,
            w: 1919.7,
            h: 1079.3,
        };
        for edge in [
            DockEdge::Left,
            DockEdge::Right,
            DockEdge::Top,
            DockEdge::Bottom,
        ] {
            let (x, y) = resolve_position(edge, area, (61.3, 199.7), 0.37);
            assert_eq!(x, x.round(), "{edge:?} x drifted");
            assert_eq!(y, y.round(), "{edge:?} y drifted");
        }
    }

    #[test]
    fn offset_round_trips_through_position() {
        for offset in [0.0, 0.25, 0.5, 1.0] {
            let pos = resolve_position(DockEdge::Right, AREA, SIZE, offset);
            let back = offset_from_position(DockEdge::Right, AREA, SIZE, pos);
            assert!((back - offset).abs() < 0.002, "{offset} -> {back}");
        }
    }

    #[test]
    fn offset_is_zero_when_the_rail_fills_its_edge() {
        // No travel means no meaningful offset, and dividing by the zero
        // travel would otherwise produce a NaN that reaches the config file.
        let offset = offset_from_position(DockEdge::Right, AREA, (60.0, 1080.0), (1860.0, 0.0));
        assert_eq!(offset, 0.0);
    }

    #[test]
    fn a_drag_near_an_edge_snaps_to_it() {
        assert_eq!(snap_edge(AREA, SIZE, (10.0, 400.0)), DockEdge::Left);
        assert_eq!(snap_edge(AREA, SIZE, (1900.0, 400.0)), DockEdge::Right);
        assert_eq!(snap_edge(AREA, (200.0, 60.0), (700.0, 12.0)), DockEdge::Top);
        assert_eq!(
            snap_edge(AREA, (200.0, 60.0), (700.0, 1030.0)),
            DockEdge::Bottom
        );
    }

    #[test]
    fn a_drag_released_in_open_space_floats() {
        assert_eq!(snap_edge(AREA, SIZE, (800.0, 400.0)), DockEdge::Floating);
    }

    #[test]
    fn a_corner_release_picks_the_nearer_edge_deterministically() {
        // 5 px from the left, 20 px from the top: left wins, and the same
        // input always produces the same answer rather than flapping.
        let edge = snap_edge(AREA, SIZE, (5.0, 20.0));
        assert_eq!(edge, DockEdge::Left);
        assert_eq!(edge, snap_edge(AREA, SIZE, (5.0, 20.0)));
    }

    #[test]
    fn a_release_just_past_the_threshold_does_not_snap() {
        assert_eq!(
            snap_edge(AREA, SIZE, (SNAP_THRESHOLD_PX + 1.0, 400.0)),
            DockEdge::Floating
        );
    }

    #[test]
    fn floating_position_is_pulled_back_onto_a_smaller_monitor() {
        let small = Rect {
            x: 0.0,
            y: 0.0,
            w: 800.0,
            h: 600.0,
        };
        let (x, y) = resolve_floating_position(small, SIZE, (5000.0, 5000.0));
        assert_eq!((x, y), (800.0 - 60.0, 600.0 - 200.0));
    }

    #[test]
    fn floating_position_keeps_a_valid_point_untouched() {
        assert_eq!(
            resolve_floating_position(AREA, SIZE, (300.0, 300.0)),
            (300.0, 300.0)
        );
    }

    #[test]
    fn point_in_rect_is_half_open_so_touching_rails_cannot_both_claim_the_cursor() {
        assert!(point_in_rect((0.0, 0.0), (0.0, 0.0), (10.0, 10.0)));
        assert!(!point_in_rect((10.0, 5.0), (0.0, 0.0), (10.0, 10.0)));
        assert!(!point_in_rect((-1.0, 5.0), (0.0, 0.0), (10.0, 10.0)));
    }

    #[test]
    fn expanding_grows_only_along_the_long_axis() {
        let (w1, h1) = rail_size(DockEdge::Right, 1, 1.0);
        let (w5, h5) = rail_size(DockEdge::Right, 5, 1.0);
        assert_eq!(w1, w5, "thickness must not change when rows are added");
        assert!(h5 > h1);
    }

    #[test]
    fn a_horizontal_rail_swaps_the_axes() {
        let (vw, vh) = rail_size(DockEdge::Right, 3, 1.0);
        let (hw, hh) = rail_size(DockEdge::Top, 3, 1.0);
        assert_eq!((vw, vh), (hh, hw));
    }

    #[test]
    fn rail_size_clamps_the_row_count_to_the_visible_maximum() {
        assert_eq!(
            rail_size(DockEdge::Right, 99, 1.0),
            rail_size(DockEdge::Right, MAX_VISIBLE_ROWS, 1.0)
        );
        assert_eq!(
            rail_size(DockEdge::Right, 0, 1.0),
            rail_size(DockEdge::Right, 1, 1.0)
        );
    }

    #[test]
    fn rail_size_scales_and_stays_pixel_aligned() {
        let (w, h) = rail_size(DockEdge::Right, 3, 0.73);
        assert_eq!(w, w.round());
        assert_eq!(h, h.round());
        assert!(w < rail_size(DockEdge::Right, 3, 1.0).0);
    }

    #[test]
    fn edge_orientation_matches_the_axis_it_runs_along() {
        assert!(DockEdge::Left.is_vertical());
        assert!(DockEdge::Right.is_vertical());
        assert!(!DockEdge::Top.is_vertical());
        assert!(!DockEdge::Bottom.is_vertical());
    }

    #[test]
    fn the_default_edge_is_the_right_hand_side() {
        assert_eq!(DockEdge::default(), DockEdge::Right);
    }
}
