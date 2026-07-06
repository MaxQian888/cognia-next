//! Unsafe AX FFI helpers for the macOS backend.
//!
//! The high-level `accessibility` crate covers reading string attributes,
//! children, and roles, but three things it can't do are needed for a *useful*
//! element tree — all diagnosed against real apps (Chrome, VS Code) during the
//! ADR-0020 macOS follow-up:
//!
//!   1. **Activate lazy web a11y.** Chromium / WebKit / Electron apps (Cognia's
//!      own WKWebView included) don't publish their web-content accessibility
//!      tree until an assistive-tech client sets `AXManualAccessibility` /
//!      `AXEnhancedUserInterface`. Without it, `AXWindows` is empty and the walk
//!      sees only the application element + menu bar — the "only window name"
//!      symptom.
//!   2. **Pick the right window.** `AXWindows[0]` is frequently an empty helper
//!      window (observed on Chrome); the focused / main window is the one the
//!      operator means.
//!   3. **Geometry.** `AXPosition` / `AXSize` are `AXValue`-wrapped CGPoint /
//!      CGSize; the crate exposes no accessor.
//!
//! These drop to raw `accessibility-sys` + `core-foundation-sys`. The whole
//! dependency graph shares a single `core-foundation-sys` 0.8, so the raw `*Ref`
//! C types are the same everywhere and pass freely. `accessibility::AXUIElement`
//! carries its `TCFType` impl from core-foundation 0.9, imported here under the
//! `cf_ax` alias purely to reach `as_concrete_TypeRef` / `wrap_under_create_rule`
//! — no CF wrapper type crosses out of this module, so the rest of the app stays
//! on core-foundation 0.10 without interop.

use std::ffi::c_void;

use accessibility::{AXUIElement, AXUIElementAttributes};
use accessibility_sys::{
    kAXErrorSuccess, kAXTrustedCheckOptionPrompt, kAXValueTypeCGPoint, kAXValueTypeCGSize,
    AXIsProcessTrusted, AXIsProcessTrustedWithOptions, AXUIElementCopyAttributeValue,
    AXUIElementRef, AXUIElementSetAttributeValue, AXValueGetValue, AXValueRef,
};
use core_foundation_0_9 as cf_ax;
use core_foundation_sys::base::{CFRelease, CFTypeRef};
use core_foundation_sys::dictionary::CFDictionaryRef;
use core_foundation_sys::number::{kCFBooleanTrue, CFBooleanGetValue, CFBooleanRef};
use core_graphics_types::geometry::{CGPoint, CGSize};

use cf_ax::base::TCFType;
use cf_ax::string::CFString;

use crate::automation::types::Rect;

fn el_ref(el: &AXUIElement) -> AXUIElementRef {
    el.as_concrete_TypeRef() as AXUIElementRef
}

fn cfstr(name: &str) -> CFString {
    CFString::new(name)
}

/// Whether this process is trusted for the Accessibility API. When false, every
/// AX read against another process returns `kAXErrorAPIDisabled`, so `read_tree`
/// would silently observe an empty tree.
pub fn is_trusted() -> bool {
    unsafe { AXIsProcessTrusted() }
}

/// Best-effort: pop the system "grant Accessibility permission" prompt. A no-op
/// if already trusted. Uses
/// `AXIsProcessTrustedWithOptions({ AXTrustedCheckOptionPrompt: true })`.
pub fn prompt_trust() {
    let key = unsafe { CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt) };
    let val = cf_ax::boolean::CFBoolean::true_value();
    let dict = cf_ax::dictionary::CFDictionary::from_CFType_pairs(&[(key.as_CFType(), val.as_CFType())]);
    unsafe {
        AXIsProcessTrustedWithOptions(dict.as_concrete_TypeRef() as CFDictionaryRef);
    }
}

/// Set a boolean attribute to true. Best-effort: unsupported / illegal-argument
/// errors on native apps are expected and ignored.
fn set_bool_attr(el: &AXUIElement, name: &str) {
    let attr = cfstr(name);
    unsafe {
        AXUIElementSetAttributeValue(el_ref(el), attr.as_concrete_TypeRef(), kCFBooleanTrue as CFTypeRef);
    }
}

/// Ask a Chromium / WebKit / Electron application to expose its web-content
/// accessibility tree. WebKit honours `AXManualAccessibility`; Chromium /
/// Electron honour `AXEnhancedUserInterface`. Harmless no-op on native apps.
pub fn activate_web_a11y(app: &AXUIElement) {
    set_bool_attr(app, "AXManualAccessibility");
    set_bool_attr(app, "AXEnhancedUserInterface");
}

/// Copy an `AXUIElement`-valued attribute (e.g. `AXFocusedWindow`) and wrap it.
fn copy_element_attr(el: &AXUIElement, name: &str) -> Option<AXUIElement> {
    let attr = cfstr(name);
    let mut out: CFTypeRef = std::ptr::null();
    let err = unsafe { AXUIElementCopyAttributeValue(el_ref(el), attr.as_concrete_TypeRef(), &mut out) };
    if err != kAXErrorSuccess || out.is_null() {
        return None;
    }
    // Copy semantics → we own a +1 reference; `wrap_under_create_rule` takes it.
    Some(unsafe { AXUIElement::wrap_under_create_rule(out as AXUIElementRef) })
}

/// Resolve the window `read_tree` should root at: the focused window, then the
/// main window, then the first window that actually has children (skips
/// empty helper windows), then the first window, then the application element
/// itself.
pub fn resolve_window_root(app: &AXUIElement) -> AXUIElement {
    if let Some(w) = copy_element_attr(app, "AXFocusedWindow") {
        return w;
    }
    if let Some(w) = copy_element_attr(app, "AXMainWindow") {
        return w;
    }
    if let Ok(windows) = app.windows() {
        let mut first: Option<AXUIElement> = None;
        for w in windows.iter() {
            let w = (*w).clone();
            if first.is_none() {
                first = Some(w.clone());
            }
            let has_children = w.children().map(|c| !c.is_empty()).unwrap_or(false);
            if has_children {
                return w;
            }
        }
        if let Some(f) = first {
            return f;
        }
    }
    app.clone()
}

/// Whether the app currently exposes at least one non-empty window. Used to
/// decide if a just-issued `activate_web_a11y` needs a settle delay before the
/// tree is readable.
pub fn has_visible_windows(app: &AXUIElement) -> bool {
    app.windows().map(|w| !w.is_empty()).unwrap_or(false)
}

/// Read `AXValue` as a string when it is one (text fields, static text). Returns
/// `None` for non-string values (sliders, checkboxes) or absent attributes.
pub fn read_value_string(el: &AXUIElement) -> Option<String> {
    let attr = cfstr("AXValue");
    let mut out: CFTypeRef = std::ptr::null();
    let err = unsafe { AXUIElementCopyAttributeValue(el_ref(el), attr.as_concrete_TypeRef(), &mut out) };
    if err != kAXErrorSuccess || out.is_null() {
        return None;
    }
    // Own the +1 ref via a CFType, then attempt a CFString downcast.
    let value = unsafe { cf_ax::base::CFType::wrap_under_create_rule(out) };
    value
        .downcast::<CFString>()
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
}

/// Read a boolean attribute (`AXEnabled` / `AXFocused`). `None` when absent.
pub fn read_bool(el: &AXUIElement, name: &str) -> Option<bool> {
    let attr = cfstr(name);
    let mut out: CFTypeRef = std::ptr::null();
    let err = unsafe { AXUIElementCopyAttributeValue(el_ref(el), attr.as_concrete_TypeRef(), &mut out) };
    if err != kAXErrorSuccess || out.is_null() {
        return None;
    }
    let v = unsafe { CFBooleanGetValue(out as CFBooleanRef) };
    unsafe { CFRelease(out) };
    Some(v)
}

fn read_ax_value_point(el: &AXUIElement, name: &str) -> Option<(f64, f64)> {
    let attr = cfstr(name);
    let mut out: CFTypeRef = std::ptr::null();
    let err = unsafe { AXUIElementCopyAttributeValue(el_ref(el), attr.as_concrete_TypeRef(), &mut out) };
    if err != kAXErrorSuccess || out.is_null() {
        return None;
    }
    let mut p = CGPoint { x: 0.0, y: 0.0 };
    let ok = unsafe {
        AXValueGetValue(out as AXValueRef, kAXValueTypeCGPoint, &mut p as *mut _ as *mut c_void)
    };
    unsafe { CFRelease(out) };
    if ok {
        Some((p.x, p.y))
    } else {
        None
    }
}

fn read_ax_value_size(el: &AXUIElement, name: &str) -> Option<(f64, f64)> {
    let attr = cfstr(name);
    let mut out: CFTypeRef = std::ptr::null();
    let err = unsafe { AXUIElementCopyAttributeValue(el_ref(el), attr.as_concrete_TypeRef(), &mut out) };
    if err != kAXErrorSuccess || out.is_null() {
        return None;
    }
    let mut s = CGSize { width: 0.0, height: 0.0 };
    let ok = unsafe {
        AXValueGetValue(out as AXValueRef, kAXValueTypeCGSize, &mut s as *mut _ as *mut c_void)
    };
    unsafe { CFRelease(out) };
    if ok {
        Some((s.width, s.height))
    } else {
        None
    }
}

/// Element bounding rect in global (screen) coordinates from `AXPosition` +
/// `AXSize`. `None` when either is absent (menus, some transient elements).
pub fn read_rect(el: &AXUIElement) -> Option<Rect> {
    let (x, y) = read_ax_value_point(el, "AXPosition")?;
    let (w, h) = read_ax_value_size(el, "AXSize")?;
    Some(Rect {
        x: x.round() as i32,
        y: y.round() as i32,
        width: w.round() as i32,
        height: h.round() as i32,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_trusted_is_callable_and_total() {
        // The real value depends on the host's Accessibility grant, so we only
        // assert the FFI is linkable and returns *a* bool. The element-walking
        // helpers (`resolve_window_root`, `read_rect`, `read_bool`, …) need a
        // live `AXUIElement` from a granted target app; they're exercised
        // against real apps during manual verification, not in unit tests —
        // same constraint as the CGEventTap recorder in `record/hook_mac.rs`.
        let _: bool = is_trusted();
    }
}
