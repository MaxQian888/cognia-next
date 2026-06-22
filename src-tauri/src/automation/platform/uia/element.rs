//! `UIElement` ↔ cross-platform `ElementInfo` conversion + the element cache.
//!
//! UIA RuntimeIds are `Vec<i32>` and not always stable across the lifetime
//! of a process. To keep the renderer-facing `ElementRef` opaque + cheap, we
//! cache `UIElement` references behind a monotonic `u64` and hand the hex
//! string back. Subsequent calls look up the element by id.
//!
//! Lifetime caveat: cached elements outlive their host window, but UIA
//! handles raise `STALE_ELEMENT` when accessed against a closed window —
//! we surface that as `AutomationError::StaleElement`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

use parking_lot::RwLock;
use uiautomation::UIElement as UiaElement;

use crate::automation::types::*;

#[derive(Default)]
pub struct ElementCache {
    inner: RwLock<HashMap<u64, UiaElement>>,
    next_id: AtomicU64,
}

impl ElementCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&self, element: UiaElement) -> ElementRef {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        self.inner.write().insert(id, element);
        ElementRef(format!("{id:x}"))
    }

    pub fn get(&self, r: &ElementRef) -> Option<UiaElement> {
        let id = parse_id(&r.0)?;
        self.inner.read().get(&id).cloned()
    }
}

fn parse_id(s: &str) -> Option<u64> {
    u64::from_str_radix(s, 16).ok()
}

/// Convert a `UiaElement` into the renderer-facing `ElementInfo`. Failures
/// reading individual properties are downgraded to `None` so a missing name
/// (common for unnamed groups) doesn't fail the whole conversion.
pub fn element_info(cache: &ElementCache, elt: &UiaElement) -> ElementInfo {
    let element_ref = cache.insert(elt.clone());
    let bounding_rect = elt.get_bounding_rectangle().ok().map(|r| Rect {
        x: r.get_left(),
        y: r.get_top(),
        width: r.get_right() - r.get_left(),
        height: r.get_bottom() - r.get_top(),
    });
    ElementInfo {
        element_ref,
        name: elt.get_name().ok().filter(|s| !s.is_empty()),
        automation_id: elt.get_automation_id().ok().filter(|s| !s.is_empty()),
        control_type: elt.get_control_type().ok().map(|ct| format!("{ct:?}")),
        class_name: elt.get_classname().ok().filter(|s| !s.is_empty()),
        bounding_rect,
        is_enabled: elt.is_enabled().unwrap_or(false),
        is_focused: elt.has_keyboard_focus().unwrap_or(false),
        process_id: elt.get_process_id().ok(),
        process_name: None,
        window_title: None,
        children: None,
    }
}
