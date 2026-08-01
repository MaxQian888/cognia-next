//! Local OCR as a *fallback* for steps accessibility could not describe.
//!
//! Two constraints shape everything here:
//!
//! - **Local only.** The trait is injected from `src-tauri`, and its
//!   implementation is restricted to the on-device backends (Apple Vision,
//!   Windows Media OCR). A cloud OCR provider is never selected automatically —
//!   sending a screenshot of whatever the user is doing to a remote service is
//!   not a fallback, it is a different product.
//! - **A bounded region, never the screen.** [`ocr_region`] returns a small box
//!   around the interaction, clipped to the recording's scope. Running OCR over
//!   a full frame would read every unrelated thing that happened to be visible.
//!
//! The trait lives here rather than in `cognia-ocr` so `cognia-automation` gains
//! no dependency on it — that edge would drag the OCR crate's model-download and
//! HTTP stack into the automation graph.

use super::journal::SafeElement;
use crate::automation::types::{Point, Rect};

/// Half-width/height of the region examined around an interaction.
pub const OCR_BOX_W: i32 = 480;
pub const OCR_BOX_H: i32 = 160;

#[async_trait::async_trait]
pub trait RegionOcr: Send + Sync {
    /// False when no on-device backend is installed. Today this is `false` on
    /// Windows, because `windows-media-ocr` is still a placeholder backend —
    /// preflight reports that honestly rather than promising a capability.
    fn available(&self) -> bool;

    /// The on-device backend ids that are actually usable, for the preflight
    /// report. Empty means the fallback is unavailable — which the setup screen
    /// states plainly rather than implying OCR that will never run.
    fn backend_ids(&self) -> Vec<String>;

    /// Extract text from an encoded image. Implementations must dispatch to a
    /// local backend and must never fall through to a network provider.
    async fn extract(&self, image_base64: String) -> Option<String>;
}

/// Should this step fall back to OCR?
///
/// Only when accessibility gave nothing an LLM could describe. A step with a
/// name or an automation id is already better described than OCR could manage,
/// and running OCR anyway would just add noise and latency.
pub fn needs_ocr(element: Option<&SafeElement>) -> bool {
    match element {
        None => true,
        Some(e) => e.is_semantically_empty(),
    }
}

/// The region to read, clipped to the scope rect.
///
/// Prefers the element's own bounds when it has them; otherwise a fixed box
/// centred on the interaction point. `None` means there is nothing to aim at,
/// in which case OCR is skipped rather than widened to the screen.
pub fn ocr_region(
    point: Option<Point>,
    element: Option<&SafeElement>,
    scope: Option<Rect>,
) -> Option<Rect> {
    let raw = match element.and_then(|e| e.bounds) {
        Some(bounds) if bounds.width > 0 && bounds.height > 0 => bounds,
        _ => {
            let p = point?;
            Rect {
                x: p.x - OCR_BOX_W / 2,
                y: p.y - OCR_BOX_H / 2,
                width: OCR_BOX_W,
                height: OCR_BOX_H,
            }
        }
    };
    let clipped = match scope {
        Some(scope) => intersect(raw, scope)?,
        None => raw,
    };
    (clipped.width > 0 && clipped.height > 0).then_some(clipped)
}

fn intersect(a: Rect, b: Rect) -> Option<Rect> {
    let x = a.x.max(b.x);
    let y = a.y.max(b.y);
    let right = (a.x.saturating_add(a.width)).min(b.x.saturating_add(b.width));
    let bottom = (a.y.saturating_add(a.height)).min(b.y.saturating_add(b.height));
    (right > x && bottom > y).then_some(Rect {
        x,
        y,
        width: right - x,
        height: bottom - y,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn named(name: &str) -> SafeElement {
        SafeElement {
            name: Some(name.into()),
            ..SafeElement::default()
        }
    }

    #[test]
    fn needs_ocr_true_when_element_absent() {
        assert!(needs_ocr(None));
    }

    #[test]
    fn needs_ocr_false_when_name_present() {
        assert!(!needs_ocr(Some(&named("Submit"))));
    }

    #[test]
    fn needs_ocr_true_when_name_is_whitespace() {
        assert!(needs_ocr(Some(&named("   "))));
    }

    #[test]
    fn needs_ocr_false_when_only_an_automation_id_is_present() {
        assert!(!needs_ocr(Some(&SafeElement {
            automation_id: Some("btnOk".into()),
            ..SafeElement::default()
        })));
    }

    #[test]
    fn ocr_region_is_bounded_not_fullscreen() {
        let region = ocr_region(Some(Point { x: 1000, y: 1000 }), None, None).unwrap();
        assert_eq!(region.width, OCR_BOX_W);
        assert_eq!(region.height, OCR_BOX_H);
        // Centred on the interaction.
        assert_eq!(region.x, 1000 - OCR_BOX_W / 2);
        assert_eq!(region.y, 1000 - OCR_BOX_H / 2);
    }

    #[test]
    fn ocr_region_prefers_the_element_bounds() {
        let element = SafeElement {
            bounds: Some(Rect {
                x: 10,
                y: 20,
                width: 30,
                height: 40,
            }),
            ..SafeElement::default()
        };
        assert_eq!(
            ocr_region(Some(Point { x: 0, y: 0 }), Some(&element), None),
            element.bounds
        );
    }

    #[test]
    fn ocr_region_ignores_degenerate_element_bounds() {
        let element = SafeElement {
            bounds: Some(Rect {
                x: 10,
                y: 20,
                width: 0,
                height: 0,
            }),
            ..SafeElement::default()
        };
        let region = ocr_region(Some(Point { x: 500, y: 500 }), Some(&element), None).unwrap();
        assert_eq!(region.width, OCR_BOX_W);
    }

    #[test]
    fn ocr_region_is_clipped_to_scope() {
        let scope = Rect {
            x: 0,
            y: 0,
            width: 100,
            height: 100,
        };
        let region = ocr_region(Some(Point { x: 50, y: 50 }), None, Some(scope)).unwrap();
        assert_eq!(region.x, 0, "clipped at the scope's left edge");
        assert_eq!(region.y, 0);
        assert!(region.x + region.width <= 100);
        assert!(region.y + region.height <= 100);
    }

    #[test]
    fn ocr_region_outside_scope_is_none() {
        let scope = Rect {
            x: 0,
            y: 0,
            width: 10,
            height: 10,
        };
        assert!(ocr_region(Some(Point { x: 5000, y: 5000 }), None, Some(scope)).is_none());
    }

    #[test]
    fn ocr_region_without_a_point_or_bounds_is_none() {
        assert!(ocr_region(None, None, None).is_none());
        assert!(ocr_region(None, Some(&named("x")), None).is_none());
    }

    #[test]
    fn intersect_of_disjoint_rects_is_none() {
        let a = Rect {
            x: 0,
            y: 0,
            width: 10,
            height: 10,
        };
        let b = Rect {
            x: 100,
            y: 100,
            width: 10,
            height: 10,
        };
        assert!(intersect(a, b).is_none());
    }

    #[test]
    fn intersect_of_touching_rects_is_none() {
        let a = Rect {
            x: 0,
            y: 0,
            width: 10,
            height: 10,
        };
        let b = Rect {
            x: 10,
            y: 0,
            width: 10,
            height: 10,
        };
        assert!(
            intersect(a, b).is_none(),
            "a zero-area overlap is not a region worth reading"
        );
    }
}
