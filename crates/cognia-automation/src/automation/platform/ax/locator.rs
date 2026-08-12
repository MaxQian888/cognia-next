//! macOS glue between live `AXUIElement`s and the platform-agnostic
//! {@link crate::automation::platform::shared::element_locator} recipe.
//!
//! The FFI lives here; the matching logic — including every ambiguity and
//! drift rule — lives in the shared module where it is unit-tested against a
//! fake tree. This file stays deliberately thin.
//!
//! Two directions:
//!
//!   - **capture** ({@link locator_for_element}) walks *up* from an element to
//!     the window root via `AXParent`, recording one {@link AncestryStep} per
//!     hop, then reverses the path. Walking up is what lets `find`,
//!     `pick_at_point` and `get_focus` hand back a real, re-resolvable ref
//!     instead of the old `macos|role=…|title=…` observability string.
//!   - **resolve** ({@link resolve_locator}) finds the application, picks the
//!     window, and replays the path.
//!
//! Both are bounded: `MAX_ANCESTRY_DEPTH` caps the upward walk so a cyclic or
//! pathological `AXParent` chain cannot hang the worker thread.

use accessibility::{AXUIElement, AXUIElementAttributes};

use crate::automation::platform::shared::element_locator::{
    describe_step, resolve_path, AncestryStep, AppIdentity, ElementLocator, LocatorBackend,
    LocatorNode, ResolveFailure, WindowIdentity,
};
use crate::automation::types::{AutomationError, Result};

use super::raw;

/// Non-empty string projection of an AX attribute read. Mirrors the helper in
/// `mod.rs`; duplicated rather than exported so this module stays independent
/// of the backend's internals.
fn str_attr<S: ToString, E>(r: std::result::Result<S, E>) -> Option<String> {
    r.ok().map(|s| s.to_string()).filter(|s| !s.is_empty())
}

/// Cap on the upward `AXParent` walk. Real UI hierarchies are well under 30
/// deep; anything beyond this is a broken or cyclic tree, and we refuse rather
/// than spin.
const MAX_ANCESTRY_DEPTH: usize = 64;

/// Newtype so `LocatorNode` (local trait) can be implemented over the foreign
/// `AXUIElement`, and so the FFI-flavoured accessors stay off the shared trait.
#[derive(Clone)]
pub struct AxNode(pub AXUIElement);

impl LocatorNode for AxNode {
    fn identifier(&self) -> Option<String> {
        str_attr(self.0.identifier())
    }
    fn role(&self) -> Option<String> {
        str_attr(self.0.role())
    }
    fn subrole(&self) -> Option<String> {
        str_attr(self.0.subrole())
    }
    fn name(&self) -> Option<String> {
        // Title first, then description — the same order `ax_element_to_info`
        // projects a display name in, so a recipe's `name` and the inspector's
        // `name` agree. `AXValue` is deliberately NOT consulted: a text field's
        // value changes as the user types, which would rot the recipe.
        str_attr(self.0.title()).or_else(|| str_attr(self.0.description()))
    }
    fn children(&self) -> Vec<Self> {
        raw::read_children_page(&self.0, 0, usize::MAX)
            .into_iter()
            .map(AxNode)
            .collect()
    }
}

/// Build a re-resolvable locator for `element`.
///
/// Returns `None` when the element cannot be tied back to a window root within
/// the depth bound — better to hand back no locator than one that will resolve
/// to the wrong node.
pub fn locator_for_element(
    element: &AXUIElement,
    pid: u32,
    process_name: Option<&str>,
    bundle_id: Option<&str>,
) -> Option<ElementLocator> {
    let app = AXUIElement::application(pid as i32);
    let window_root = raw::resolve_window_root(&app);
    let root_identity = raw::element_identity(&window_root);

    // Walk up, recording each hop as "which child of my parent am I".
    let mut reversed: Vec<AncestryStep> = Vec::new();
    let mut current = element.clone();
    let mut reached_root = raw::element_identity(&current) == root_identity;

    for _ in 0..MAX_ANCESTRY_DEPTH {
        if reached_root {
            break;
        }
        let Some(parent) = raw::parent(&current) else {
            break;
        };
        let parent_node = AxNode(parent.clone());
        let current_identity = raw::element_identity(&current);
        let index = parent_node
            .children()
            .iter()
            .position(|c| raw::element_identity(&c.0) == current_identity)?;
        reversed.push(describe_step(&parent_node, index)?);

        current = parent;
        if raw::element_identity(&current) == root_identity {
            reached_root = true;
        }
    }

    if !reached_root {
        return None;
    }

    reversed.reverse();
    let mut locator = ElementLocator::new(
        LocatorBackend::Macos,
        AppIdentity {
            pid,
            bundle_id: bundle_id.map(str::to_owned),
            process_name: process_name.map(str::to_owned),
        },
    );
    locator.window = WindowIdentity {
        title: AxNode(window_root).name(),
        ordinal: None,
    };
    locator.path = reversed;
    Some(locator)
}

/// Build a locator for the window root itself — the ref `get_focus` hands back
/// when it has no more specific element.
pub fn locator_for_window_root(
    pid: u32,
    process_name: Option<&str>,
    bundle_id: Option<&str>,
) -> ElementLocator {
    let app = AXUIElement::application(pid as i32);
    let window_root = raw::resolve_window_root(&app);
    let mut locator = ElementLocator::new(
        LocatorBackend::Macos,
        AppIdentity {
            pid,
            bundle_id: bundle_id.map(str::to_owned),
            process_name: process_name.map(str::to_owned),
        },
    );
    locator.window = WindowIdentity {
        title: AxNode(window_root).name(),
        ordinal: None,
    };
    locator
}

/// Replay a locator against the live tree.
///
/// Every failure mode collapses to `StaleElement`, which is the contract the
/// caller already handles: the ref no longer identifies exactly one node.
/// Ambiguity is a refusal, not a coin flip — acting on an arbitrary one of two
/// matching siblings would click the wrong control.
pub fn resolve_locator(locator: &ElementLocator) -> Result<AXUIElement> {
    if locator.backend != LocatorBackend::Macos {
        return Err(AutomationError::StaleElement);
    }
    let app = AXUIElement::application(locator.app.pid as i32);
    raw::set_messaging_timeout(&app, 0.25);
    // A dead pid yields an application element whose window resolution falls
    // back to the app element itself with no children, so the path walk below
    // fails with NotFound → StaleElement. No separate liveness probe needed.
    let window_root = AxNode(raw::resolve_window_root(&app));

    match resolve_path(window_root, &locator.path) {
        Ok(node) => Ok(node.0),
        Err(ResolveFailure::NotFound) | Err(ResolveFailure::Ambiguous) => {
            Err(AutomationError::StaleElement)
        }
    }
}
