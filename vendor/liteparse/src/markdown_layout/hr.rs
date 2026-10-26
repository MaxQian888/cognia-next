use crate::types::{GraphicPrimitive, ParsedPage, Rect};

/// Maximum stroke thickness (or |y1-y2|) for a stroke to count as a candidate HR.
/// Thicker shapes are filled rects, not rules.
const HR_MAX_THICKNESS_PT: f32 = 2.0;

/// Minimum fraction of page width a horizontal stroke must span to count as an HR.
/// Shorter strokes are typically table borders, list bullets, or inline marks.
const HR_MIN_WIDTH_FRACTION: f32 = 0.3;

/// Vertical tolerance (points) for treating a stroke as "underlining" the
/// nearest text line. Strokes within this band of a text line's baseline are
/// dropped — they're underlines, not rules.
const HR_UNDERLINE_PROXIMITY_PT: f32 = 3.0;

/// Detect horizontal rules from a page's vector graphics.
///
/// Returns the accepted HRs (viewport space) as rects, sorted by y ascending.
/// The rect spans the stroke's drawn x-extent and carries its thickness, so a
/// rule reports the region it actually occupies rather than just its baseline.
/// An HR is a roughly horizontal stroke that spans at least
/// `HR_MIN_WIDTH_FRACTION` of the page width, is thinner than
/// `HR_MAX_THICKNESS_PT`, and does not sit on the baseline of any text line
/// (which would make it an underline).
pub(super) fn detect_horizontal_rules(page: &ParsedPage) -> Vec<Rect> {
    if page.graphics.is_empty() || page.page_width <= 0.0 {
        return Vec::new();
    }
    let min_width = page.page_width * HR_MIN_WIDTH_FRACTION;
    let mut rules: Vec<Rect> = Vec::new();

    for g in &page.graphics {
        let GraphicPrimitive::Stroke {
            x1,
            y1,
            x2,
            y2,
            width,
            ..
        } = g
        else {
            continue;
        };
        let (x1, y1, x2, y2, width) = (*x1, *y1, *x2, *y2, *width);
        let dy = (y1 - y2).abs();
        let dx = (x1 - x2).abs();
        if dy > HR_MAX_THICKNESS_PT || width > HR_MAX_THICKNESS_PT {
            continue;
        }
        if dx < min_width {
            continue;
        }
        let y = (y1 + y2) * 0.5;
        let xmin = x1.min(x2);
        let xmax = x1.max(x2);

        // Drop if this stroke sits on a text-line baseline — it's an underline,
        // not a divider.
        let is_underline = page.projected_lines.iter().any(|line| {
            let bottom = line.bbox.y + line.bbox.height;
            (y - bottom).abs() < HR_UNDERLINE_PROXIMITY_PT
                && xmin >= line.bbox.x - 2.0
                && xmax <= line.bbox.x + line.bbox.width + 2.0
        });
        if is_underline {
            continue;
        }
        rules.push(Rect {
            x: xmin,
            y,
            width: (xmax - xmin).max(0.0),
            // A hairline can report zero thickness; keep the drawn width so the
            // rect is never degenerate.
            height: dy.max(width),
        });
    }

    // Sort + dedup near-duplicates (some PDFs draw the same rule twice).
    rules.sort_by(|a, b| a.y.total_cmp(&b.y));
    rules.dedup_by(|a, b| (a.y - b.y).abs() < 1.0);
    rules
}

#[cfg(test)]
mod tests {
    use super::super::test_helpers::{line, page_with_graphics, stroke};
    use super::*;

    #[test]
    fn hr_long_thin_horizontal_stroke_detected() {
        // 400pt wide stroke on a 612pt page → comfortably above 30% threshold.
        let p = page_with_graphics(vec![], vec![stroke(50.0, 200.0, 450.0, 200.5, 0.5)]);
        let rules = detect_horizontal_rules(&p);
        let ys: Vec<f32> = rules.iter().map(|r| r.y).collect();
        assert_eq!(ys, vec![200.25]);
        // The rule reports the stroke's drawn extent, not just its baseline.
        assert_eq!(rules[0].x, 50.0);
        assert_eq!(rules[0].width, 400.0);
    }

    #[test]
    fn hr_short_stroke_rejected() {
        // 50pt wide — table border or list bullet, not an HR.
        let p = page_with_graphics(vec![], vec![stroke(50.0, 200.0, 100.0, 200.0, 0.5)]);
        assert!(detect_horizontal_rules(&p).is_empty());
    }

    #[test]
    fn hr_vertical_stroke_rejected() {
        let p = page_with_graphics(vec![], vec![stroke(50.0, 50.0, 50.0, 500.0, 0.5)]);
        assert!(detect_horizontal_rules(&p).is_empty());
    }

    #[test]
    fn hr_thick_stroke_rejected() {
        // 4pt-thick stroke → a filled bar, not a rule.
        let p = page_with_graphics(vec![], vec![stroke(50.0, 200.0, 450.0, 200.0, 4.0)]);
        assert!(detect_horizontal_rules(&p).is_empty());
    }

    #[test]
    fn hr_underline_at_text_baseline_dropped() {
        // Text line at y=100 height=10 → bottom at y=110. Stroke at y=111 within
        // the line's horizontal extent → underline, not an HR.
        let text_line = line(
            "Some underlined heading text on the page",
            50.0,
            100.0,
            10.0,
            10.0,
        );
        let bottom = text_line.bbox.y + text_line.bbox.height;
        let p = page_with_graphics(
            vec![text_line.clone()],
            vec![stroke(
                50.0,
                bottom + 1.0,
                50.0 + text_line.bbox.width,
                bottom + 1.0,
                0.5,
            )],
        );
        assert!(detect_horizontal_rules(&p).is_empty());
    }
}
