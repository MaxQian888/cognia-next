//! Figure-region clustering from page vector graphics.
//!
//! Groups significant vector graphics (filled rects, stroke clusters that
//! aren't HR-like or table-grid-like) into figure bounding rectangles. These
//! rects are fed into the XY-cut layout pass as obstacles, so the recursion
//! partitions around figures (e.g. an abstract column next to a figure that
//! straddles two columns on the first page of an academic paper).
//!
//! Detection is intentionally cautious — false positives here corrupt the
//! reading order. When in doubt we drop the cluster.

use crate::types::{GraphicPrimitive, Rect, TextItem};

/// Min figure dimension on each axis (points).
const FIG_MIN_EXTENT_PT: f32 = 30.0;
/// Min figure area (points²).
const FIG_MIN_AREA_PT2: f32 = 1500.0;
/// Max figure dimension as a fraction of the page (drop full-page backgrounds
/// and any cluster that has grown to consume virtually the whole page).
const FIG_MAX_FRACTION: f32 = 0.95;
/// Cluster two primitives when their bboxes overlap or are within this gap on
/// both axes.
const FIG_CLUSTER_GAP_PT: f32 = 10.0;
/// Drop horizontal-rule-like strokes (long thin horizontal) before clustering
/// so a section divider doesn't become a degenerate "figure".
const HR_MIN_WIDTH_FRACTION: f32 = 0.3;
const HR_MAX_THICKNESS_PT: f32 = 2.0;
/// Aspect ratio threshold above which a cluster is considered "linear" (e.g. a
/// single rule, an underline cluster) rather than a figure.
const FIG_MAX_ASPECT_RATIO: f32 = 15.0;
/// Min primitives in a cluster unless any single primitive is itself large.
const FIG_LARGE_SOLO_AREA: f32 = 5000.0;
/// Fraction of a cluster's area that may be covered by text before we treat
/// the cluster as a text background rather than a figure.
const FIG_MAX_TEXT_COVERAGE: f32 = 0.55;

/// Detect figure rectangles on a page.
///
/// Returns a list of bounding rectangles, each enclosing a vector-graphics
/// cluster judged to be a figure (chart, diagram, embedded illustration).
/// Empty when the page has no significant graphics.
pub fn detect_figure_rects(
    graphics: &[GraphicPrimitive],
    text_items: &[TextItem],
    page_width: f32,
    page_height: f32,
) -> Vec<Rect> {
    if graphics.is_empty() || page_width <= 0.0 || page_height <= 0.0 {
        return Vec::new();
    }

    // Pre-filter primitives.
    let hr_min_width = page_width * HR_MIN_WIDTH_FRACTION;
    let mut bboxes: Vec<Rect> = Vec::with_capacity(graphics.len());
    for g in graphics {
        let bbox = g.bbox();
        // Drop full-page rects (page background paint).
        if bbox.width >= page_width * FIG_MAX_FRACTION
            && bbox.height >= page_height * FIG_MAX_FRACTION
        {
            continue;
        }
        match g {
            GraphicPrimitive::Stroke {
                x1,
                y1,
                x2,
                y2,
                width,
                ..
            } => {
                let dx = (x2 - x1).abs();
                let dy = (y2 - y1).abs();
                // HR-like: long thin horizontal stroke → section divider, not figure.
                if dy <= HR_MAX_THICKNESS_PT && *width <= HR_MAX_THICKNESS_PT && dx >= hr_min_width
                {
                    continue;
                }
                // Tiny strokes (glyph artifacts, sub-pixel cleanup).
                if dx < 4.0 && dy < 4.0 {
                    continue;
                }
            }
            GraphicPrimitive::Rect { .. } => {
                // Tiny rects also dropped to avoid pulling glyph artifacts in.
                if bbox.width < 2.0 && bbox.height < 2.0 {
                    continue;
                }
            }
        }
        bboxes.push(bbox);
    }
    if bboxes.is_empty() {
        return Vec::new();
    }

    // Union-find: link primitives whose bboxes are close on BOTH axes.
    let n = bboxes.len();
    let mut parent: Vec<usize> = (0..n).collect();
    for i in 0..n {
        for j in (i + 1)..n {
            if close_enough(&bboxes[i], &bboxes[j], FIG_CLUSTER_GAP_PT) {
                uf_union(&mut parent, i, j);
            }
        }
    }

    use std::collections::HashMap;
    let mut groups: HashMap<usize, (Rect, usize)> = HashMap::new();
    for (i, bb) in bboxes.iter().enumerate() {
        let r = uf_find(&mut parent, i);
        groups
            .entry(r)
            .and_modify(|entry| {
                entry.0 = union_rect(&entry.0, bb);
                entry.1 += 1;
            })
            .or_insert_with(|| (bb.clone(), 1));
    }

    let mut out = Vec::new();
    for (bbox, count) in groups.into_values() {
        if !is_figure_cluster(&bbox, count, page_width, page_height, text_items) {
            continue;
        }
        out.push(bbox);
    }
    // Sort by y then x so callers see deterministic ordering.
    out.sort_by(|a, b| a.y.total_cmp(&b.y).then(a.x.total_cmp(&b.x)));
    out
}

fn is_figure_cluster(
    bbox: &Rect,
    primitive_count: usize,
    page_width: f32,
    page_height: f32,
    text_items: &[TextItem],
) -> bool {
    if bbox.width < FIG_MIN_EXTENT_PT || bbox.height < FIG_MIN_EXTENT_PT {
        return false;
    }
    let area = bbox.width * bbox.height;
    if area < FIG_MIN_AREA_PT2 {
        return false;
    }
    if bbox.width >= page_width * FIG_MAX_FRACTION && bbox.height >= page_height * FIG_MAX_FRACTION
    {
        return false;
    }
    let ratio = if bbox.width >= bbox.height {
        bbox.width / bbox.height.max(0.01)
    } else {
        bbox.height / bbox.width.max(0.01)
    };
    if ratio > FIG_MAX_ASPECT_RATIO {
        return false;
    }
    if primitive_count < 2 && area < FIG_LARGE_SOLO_AREA {
        return false;
    }
    if text_coverage(bbox, text_items) > FIG_MAX_TEXT_COVERAGE {
        return false;
    }
    true
}

fn close_enough(a: &Rect, b: &Rect, gap: f32) -> bool {
    let x_gap = (a.x - (b.x + b.width)).max(b.x - (a.x + a.width));
    let y_gap = (a.y - (b.y + b.height)).max(b.y - (a.y + a.height));
    x_gap <= gap && y_gap <= gap
}

fn union_rect(a: &Rect, b: &Rect) -> Rect {
    let x = a.x.min(b.x);
    let y = a.y.min(b.y);
    let x2 = (a.x + a.width).max(b.x + b.width);
    let y2 = (a.y + a.height).max(b.y + b.height);
    Rect {
        x,
        y,
        width: x2 - x,
        height: y2 - y,
    }
}

/// Fraction of `bbox` area covered by text. Computed by y-banding the items
/// inside `bbox` into lines (same y within `±0.5 × median_h`) and taking the
/// union bbox of each band — that's a much better proxy for "this region is
/// dominated by text" than summing per-glyph rectangles, which leaves the
/// large inter-word and inter-cell gaps unaccounted for and lets text-dense
/// tables slip below a reasonable coverage threshold.
fn text_coverage(bbox: &Rect, text_items: &[TextItem]) -> f32 {
    let bbox_area = bbox.width * bbox.height;
    if bbox_area <= 0.0 {
        return 0.0;
    }
    // Collect items that overlap the bbox (any intersection), keep their
    // clipped extents.
    let mut clipped: Vec<(f32, f32, f32, f32)> = Vec::new();
    let mut heights: Vec<f32> = Vec::new();
    for it in text_items {
        let ix0 = it.x.max(bbox.x);
        let iy0 = it.y.max(bbox.y);
        let ix1 = (it.x + it.width).min(bbox.x + bbox.width);
        let iy1 = (it.y + it.height).min(bbox.y + bbox.height);
        if ix1 <= ix0 || iy1 <= iy0 {
            continue;
        }
        clipped.push((ix0, iy0, ix1, iy1));
        let h = it.height.max(iy1 - iy0).max(0.0);
        if h > 0.5 {
            heights.push(h);
        }
    }
    if clipped.is_empty() {
        return 0.0;
    }
    let median_h = {
        let mut h = heights;
        if h.is_empty() {
            8.0
        } else {
            h.sort_by(|a, b| a.total_cmp(b));
            h[h.len() / 2].max(4.0)
        }
    };
    let band = median_h * 0.5;
    // Sort by y midpoint, then greedy y-band into "lines": items whose
    // y-midpoints are within `band` form one line.
    clipped.sort_by(|a, b| {
        let am = (a.1 + a.3) * 0.5;
        let bm = (b.1 + b.3) * 0.5;
        am.total_cmp(&bm)
    });
    let mut covered = 0.0f32;
    let mut iter = clipped.into_iter();
    let mut cur = iter.next().unwrap();
    for nxt in iter {
        let cur_mid = (cur.1 + cur.3) * 0.5;
        let nxt_mid = (nxt.1 + nxt.3) * 0.5;
        if (nxt_mid - cur_mid).abs() <= band {
            cur.0 = cur.0.min(nxt.0);
            cur.1 = cur.1.min(nxt.1);
            cur.2 = cur.2.max(nxt.2);
            cur.3 = cur.3.max(nxt.3);
        } else {
            covered += (cur.2 - cur.0) * (cur.3 - cur.1);
            cur = nxt;
        }
    }
    covered += (cur.2 - cur.0) * (cur.3 - cur.1);
    (covered / bbox_area).min(1.0)
}

fn uf_find(parent: &mut [usize], mut x: usize) -> usize {
    while parent[x] != x {
        parent[x] = parent[parent[x]];
        x = parent[x];
    }
    x
}

fn uf_union(parent: &mut [usize], a: usize, b: usize) {
    let ra = uf_find(parent, a);
    let rb = uf_find(parent, b);
    if ra != rb {
        parent[ra] = rb;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stroke(x1: f32, y1: f32, x2: f32, y2: f32) -> GraphicPrimitive {
        GraphicPrimitive::Stroke {
            x1,
            y1,
            x2,
            y2,
            color: None,
            width: 0.5,
        }
    }

    fn rect(x: f32, y: f32, w: f32, h: f32) -> GraphicPrimitive {
        GraphicPrimitive::Rect {
            bbox: Rect {
                x,
                y,
                width: w,
                height: h,
            },
            fill: None,
            stroke: None,
        }
    }

    #[test]
    fn empty_input_returns_no_figures() {
        let figs = detect_figure_rects(&[], &[], 612.0, 792.0);
        assert!(figs.is_empty());
    }

    #[test]
    fn long_thin_hr_is_not_a_figure() {
        // A divider stroke 400pt wide × 0.5pt thick.
        let g = vec![stroke(100.0, 400.0, 500.0, 400.0)];
        let figs = detect_figure_rects(&g, &[], 612.0, 792.0);
        assert!(figs.is_empty(), "HR should not be classified as figure");
    }

    #[test]
    fn dense_stroke_cluster_becomes_a_figure() {
        // 30 short strokes packed into a 200×150pt area — looks like a chart.
        let mut g = Vec::new();
        for i in 0..6 {
            for j in 0..5 {
                let x = 100.0 + i as f32 * 30.0;
                let y = 200.0 + j as f32 * 25.0;
                g.push(stroke(x, y, x + 20.0, y + 15.0));
            }
        }
        let figs = detect_figure_rects(&g, &[], 612.0, 792.0);
        assert_eq!(figs.len(), 1, "expected one figure cluster");
        let f = &figs[0];
        assert!(f.width >= 100.0 && f.height >= 100.0);
        assert!(f.x >= 90.0 && f.x <= 110.0);
    }

    #[test]
    fn large_solo_rect_qualifies_as_figure() {
        // A single filled rect 200×100pt — area > FIG_LARGE_SOLO_AREA.
        let g = vec![rect(100.0, 300.0, 200.0, 100.0)];
        let figs = detect_figure_rects(&g, &[], 612.0, 792.0);
        assert_eq!(figs.len(), 1);
    }

    #[test]
    fn full_page_background_rect_is_skipped() {
        let g = vec![rect(0.0, 0.0, 612.0, 792.0)];
        let figs = detect_figure_rects(&g, &[], 612.0, 792.0);
        assert!(figs.is_empty(), "full-page rect should not be a figure");
    }

    #[test]
    fn text_heavy_rect_is_treated_as_background_not_figure() {
        // A 200×100pt rect entirely filled with text — should be rejected.
        let g = vec![rect(100.0, 100.0, 200.0, 100.0)];
        let mut text = Vec::new();
        for row in 0..8 {
            text.push(TextItem {
                text: "lorem ipsum dolor".into(),
                x: 105.0,
                y: 105.0 + row as f32 * 12.0,
                width: 190.0,
                height: 10.0,
                ..Default::default()
            });
        }
        let figs = detect_figure_rects(&g, &text, 612.0, 792.0);
        assert!(
            figs.is_empty(),
            "text-covered rect should not be classified as a figure"
        );
    }

    #[test]
    fn distant_strokes_do_not_merge() {
        // Two clusters far apart (>>10pt gap on both axes).
        let mut g = Vec::new();
        for i in 0..6 {
            for j in 0..5 {
                let x = 50.0 + i as f32 * 25.0;
                let y = 100.0 + j as f32 * 20.0;
                g.push(stroke(x, y, x + 18.0, y + 12.0));
            }
        }
        for i in 0..6 {
            for j in 0..5 {
                let x = 400.0 + i as f32 * 25.0;
                let y = 500.0 + j as f32 * 20.0;
                g.push(stroke(x, y, x + 18.0, y + 12.0));
            }
        }
        let figs = detect_figure_rects(&g, &[], 612.0, 792.0);
        assert_eq!(figs.len(), 2, "expected two separate figure clusters");
    }
}
