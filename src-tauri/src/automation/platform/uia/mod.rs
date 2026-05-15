//! Windows UI Automation back-end. Wraps `leexgone/uiautomation-rs` 0.25.
//!
//! The `UiaBackend` is constructed once on the worker thread (so COM is
//! initialized once in MTA). Every method is sync and assumes it's called
//! from that thread — the trait being `Send + !Sync` is enforced naturally
//! because `UIAutomation` is `Send` but not `Sync`.

use uiautomation::types::TreeScope;
use uiautomation::UIAutomation;

use crate::automation::backend::AutomationBackend;
use crate::automation::types::*;

mod element;
mod find;
mod input;
mod pattern;

use crate::automation::platform::shared::screenshot;
use element::{element_info, ElementCache};

pub struct UiaBackend {
    automation: UIAutomation,
    cache: ElementCache,
}

impl UiaBackend {
    pub fn new() -> std::result::Result<Self, String> {
        let automation =
            UIAutomation::new().map_err(|e| format!("UIAutomation::new failed: {e}"))?;
        Ok(Self {
            automation,
            cache: ElementCache::new(),
        })
    }
}

impl AutomationBackend for UiaBackend {
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            platform: Platform::Windows,
            has_uia: true,
            has_input_sim: true,
            has_screenshot: true,
            has_events: false, // M1.6 ships without UIA events; M2 adds them.
        }
    }

    fn get_focus(&self) -> Result<ElementInfo> {
        let elt = self
            .automation
            .get_focused_element()
            .map_err(|e| AutomationError::BackendError {
                message: format!("get_focused_element: {e}"),
            })?;
        Ok(element_info(&self.cache, &elt))
    }

    fn read_tree(&self, root: Option<ElementRef>, opts: TreeOpts) -> Result<Vec<ElementInfo>> {
        let root_elt = if let Some(r) = root {
            self.cache
                .get(&r)
                .ok_or(AutomationError::StaleElement)?
        } else {
            self.automation
                .get_root_element()
                .map_err(|e| AutomationError::BackendError {
                    message: format!("get_root_element: {e}"),
                })?
        };
        let max_depth = opts.max_depth.unwrap_or(2);
        let mut out = Vec::new();
        walk(&self.cache, &self.automation, &root_elt, max_depth, &mut out)?;
        Ok(out)
    }

    fn find(&self, locator: &Locator) -> Result<Option<ElementRef>> {
        let from_elt = if let Some(r) = &locator.from {
            self.cache.get(r)
        } else {
            None
        };
        let matcher = find::build_matcher(&self.automation, locator, from_elt.as_ref());
        match matcher.find_first() {
            Ok(elt) => Ok(Some(self.cache.insert(elt))),
            Err(_) => Ok(None),
        }
    }

    fn screenshot(&self, opts: ScreenshotOpts) -> Result<Screenshot> {
        screenshot::capture_primary(&opts)
    }

    fn click(&self, target: ClickTarget, opts: ClickOpts) -> Result<()> {
        match target {
            ClickTarget::Element { element_ref } => {
                let elt = self
                    .cache
                    .get(&element_ref)
                    .ok_or(AutomationError::StaleElement)?;

                // UIA Pattern-first click strategy. `useNative` defaults to
                // true: try Invoke → Toggle → SelectionItem; on miss, fall
                // back to a coordinate click at the bounding-rect center.
                let use_native = opts.use_native.unwrap_or(true);
                if use_native {
                    if let Ok(true) = pattern::try_pattern_click(&elt) {
                        return Ok(());
                    }
                }

                // Fallback path 1: try the element's native `click()` method
                // (uiautomation crate's helper that synthesizes input at the
                // element's clickable point).
                if elt.click().is_ok() {
                    return Ok(());
                }

                // Fallback path 2: bounding-rect center coordinate click.
                let rect =
                    elt.get_bounding_rectangle()
                        .map_err(|e| AutomationError::BackendError {
                            message: format!("bounding_rect for fallback click: {e}"),
                        })?;
                let cx = (rect.get_left() + rect.get_right()) / 2;
                let cy = (rect.get_top() + rect.get_bottom()) / 2;
                input::click_point(cx, cy)
            }
            ClickTarget::Point { x, y } => input::click_point(x, y),
        }
    }

    fn type_text(&self, text: &str, opts: TypeOpts) -> Result<()> {
        if let Some(target) = &opts.target {
            let elt = self.cache.get(target).ok_or(AutomationError::StaleElement)?;
            elt.set_focus()
                .map_err(|e| AutomationError::BackendError {
                    message: format!("set_focus: {e}"),
                })?;
        }
        input::type_text(text, opts.delay_ms)
    }

    fn send_keys(&self, chord: &KeyChord) -> Result<()> {
        input::send_chord(chord)
    }

    fn invoke_pattern(
        &self,
        target: ElementRef,
        kind: PatternKind,
        args: serde_json::Value,
    ) -> Result<serde_json::Value> {
        let elt = self.cache.get(&target).ok_or(AutomationError::StaleElement)?;
        pattern::dispatch_pattern(&elt, kind, args)
    }

    fn window_op(&self, target: ElementRef, op: WindowOp) -> Result<()> {
        let elt = self.cache.get(&target).ok_or(AutomationError::StaleElement)?;
        pattern::dispatch_window_op(&elt, op)
    }

    fn subscribe_events(&self, _filter: EventFilter) -> Result<SubscriptionId> {
        // Event subscription requires forwarding UIA's COM-thread callbacks
        // through an mpsc channel. M2 adds this; M1 advertises hasEvents=false.
        Err(AutomationError::BackendError {
            message: "subscribe_events pending M2".into(),
        })
    }
    fn unsubscribe(&self, _sub: SubscriptionId) -> Result<()> {
        Err(AutomationError::BackendError {
            message: "unsubscribe pending M2".into(),
        })
    }

    // ── M5 completion primitives ─────────────────────────────────────────

    fn mouse_move(&self, point: Point) -> Result<()> {
        input::move_to(point.x, point.y)
    }

    fn drag(&self, from: Point, to: Point, opts: DragOpts) -> Result<()> {
        input::drag(from, to, opts)
    }

    fn scroll(&self, target: ScrollTarget, opts: ScrollOpts) -> Result<()> {
        match target {
            ScrollTarget::Element { element_ref } => {
                let elt = self
                    .cache
                    .get(&element_ref)
                    .ok_or(AutomationError::StaleElement)?;

                // Pattern-first: ScrollPattern → ScrollItemPattern → wheel.
                if let Ok(p) = elt.get_pattern::<uiautomation::patterns::UIScrollPattern>() {
                    let (h, v) = pattern::scroll_amounts(opts);
                    p.scroll(h, v)
                        .map_err(|e| AutomationError::BackendError {
                            message: format!("ScrollPattern.scroll: {e}"),
                        })?;
                    return Ok(());
                }
                if opts.dy != 0 {
                    if let Ok(p) = elt
                        .get_pattern::<uiautomation::patterns::UIScrollItemPattern>()
                    {
                        p.scroll_into_view()
                            .map_err(|e| AutomationError::BackendError {
                                message: format!("ScrollItem.scroll_into_view: {e}"),
                            })?;
                        return Ok(());
                    }
                }
                // Fallback to wheel at the element's bounding center.
                let rect =
                    elt.get_bounding_rectangle()
                        .map_err(|e| AutomationError::BackendError {
                            message: format!("bounding_rect for wheel scroll: {e}"),
                        })?;
                let cx = (rect.get_left() + rect.get_right()) / 2;
                let cy = (rect.get_top() + rect.get_bottom()) / 2;
                input::scroll_at(Point { x: cx, y: cy }, opts)
            }
            ScrollTarget::Point { x, y } => input::scroll_at(Point { x, y }, opts),
        }
    }

    fn hold_key(&self, chord: &KeyChord, duration_ms: u32) -> Result<()> {
        input::hold_key(chord, duration_ms)
    }

    fn mouse_button(
        &self,
        button: MouseButton,
        transition: ButtonTransition,
    ) -> Result<()> {
        input::button(button, transition)
    }
}

/// Depth-bounded tree walk. Each yielded node has `children = None` (we
/// flatten into the returned Vec instead of nesting) so the renderer can
/// rebuild the tree by `parent_ref` if it needs to.
fn walk(
    cache: &ElementCache,
    automation: &UIAutomation,
    root: &uiautomation::UIElement,
    max_depth: u32,
    out: &mut Vec<ElementInfo>,
) -> Result<()> {
    out.push(element_info(cache, root));
    if max_depth == 0 {
        return Ok(());
    }
    let cond = automation
        .create_true_condition()
        .map_err(|e| AutomationError::BackendError {
            message: format!("create_true_condition: {e}"),
        })?;
    let children =
        root.find_all(TreeScope::Children, &cond)
            .map_err(|e| AutomationError::BackendError {
                message: format!("find_all children: {e}"),
            })?;
    for child in &children {
        walk(cache, automation, child, max_depth - 1, out)?;
    }
    Ok(())
}
