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
mod screenshot;

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
                elt.click().map_err(|e| AutomationError::BackendError {
                    message: format!("element click: {e}"),
                })?;
                let _ = opts; // ClickOpts.button/double/modifier ignored for element-target clicks.
                Ok(())
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
        _target: ElementRef,
        _pattern: PatternKind,
        _args: serde_json::Value,
    ) -> Result<serde_json::Value> {
        // Generic pattern dispatch is broad surface — M2 ships InvokePattern
        // / TogglePattern / ValuePattern / WindowPattern / TransformPattern.
        Err(AutomationError::BackendError {
            message: "invoke_pattern pending M2".into(),
        })
    }

    fn window_op(&self, target: ElementRef, op: WindowOp) -> Result<()> {
        let elt = self.cache.get(&target).ok_or(AutomationError::StaleElement)?;
        match op {
            WindowOp::Focus => elt
                .set_focus()
                .map_err(|e| AutomationError::BackendError {
                    message: format!("focus: {e}"),
                }),
            _ => Err(AutomationError::BackendError {
                message: "window_op variant pending M2".into(),
            }),
        }
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
