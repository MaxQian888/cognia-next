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
//! carries its `TCFType` impl from core-foundation 0.10, shared with the rest of
//! the application.

use std::ffi::c_void;

use accessibility::{AXUIElement, AXUIElementAttributes};
use accessibility_sys::{
    kAXErrorSuccess, kAXTrustedCheckOptionPrompt, kAXValueTypeCFRange, kAXValueTypeCGPoint,
    kAXValueTypeCGRect, kAXValueTypeCGSize, AXIsProcessTrusted, AXIsProcessTrustedWithOptions,
    AXUIElementCopyAttributeValue, AXUIElementCopyAttributeValues,
    AXUIElementCopyElementAtPosition, AXUIElementCopyParameterizedAttributeValue,
    AXUIElementCreateSystemWide, AXUIElementGetAttributeValueCount, AXUIElementGetPid,
    AXUIElementRef, AXUIElementSetAttributeValue, AXUIElementSetMessagingTimeout, AXValueCreate,
    AXValueGetValue, AXValueRef,
};
use core_foundation as cf_ax;
use core_foundation_sys::array::CFArrayRef;
use core_foundation_sys::base::{CFRange, CFRelease, CFTypeRef};
use core_foundation_sys::dictionary::CFDictionaryRef;
use core_foundation_sys::number::{kCFBooleanTrue, CFBooleanGetValue, CFBooleanRef};
use core_graphics_types::geometry::{CGPoint, CGRect, CGSize};

use cf_ax::base::TCFType;
use cf_ax::string::CFString;

use crate::automation::types::Rect;

fn el_ref(el: &AXUIElement) -> AXUIElementRef {
    el.as_concrete_TypeRef() as AXUIElementRef
}

pub fn element_identity(el: &AXUIElement) -> usize {
    el_ref(el) as usize
}

/// The element's `AXParent`, or `None` at the top of the hierarchy.
///
/// Needed to build a locator recipe for an element we were handed rather than
/// walked down to (`find`, `pick_at_point`, `get_focus`): the recipe is a path
/// from the window root, so it has to be reconstructed upwards.
pub fn parent(el: &AXUIElement) -> Option<AXUIElement> {
    copy_element_attr(el, "AXParent")
}

/// Read only the requested AXChildren slice. Calling the high-level
/// `children()` accessor copies the entire collection before the traversal can
/// apply its node budget, which is unsafe for 10k+ node WebView/Electron trees.
pub fn read_children_page(el: &AXUIElement, offset: usize, limit: usize) -> Vec<AXUIElement> {
    if limit == 0 {
        return Vec::new();
    }
    let attribute = cfstr("AXChildren");
    let mut count = 0;
    let count_error = unsafe {
        AXUIElementGetAttributeValueCount(el_ref(el), attribute.as_concrete_TypeRef(), &mut count)
    };
    if count_error != kAXErrorSuccess || count <= 0 || offset >= count as usize {
        return Vec::new();
    }
    let page_size = limit.min(count as usize - offset);
    let mut values: CFArrayRef = std::ptr::null();
    let copy_error = unsafe {
        AXUIElementCopyAttributeValues(
            el_ref(el),
            attribute.as_concrete_TypeRef(),
            offset as isize,
            page_size as isize,
            &mut values,
        )
    };
    if copy_error != kAXErrorSuccess || values.is_null() {
        return Vec::new();
    }
    let values = unsafe { cf_ax::array::CFArray::<AXUIElement>::wrap_under_create_rule(values) };
    values.iter().map(|child| (*child).clone()).collect()
}

pub fn perform_action(el: &AXUIElement, action: &str) -> Result<(), i32> {
    let action = cfstr(action);
    let error = unsafe {
        accessibility_sys::AXUIElementPerformAction(el_ref(el), action.as_concrete_TypeRef())
    };
    if error == kAXErrorSuccess {
        Ok(())
    } else {
        Err(error)
    }
}

pub fn set_string_value(el: &AXUIElement, attribute: &str, value: &str) -> Result<(), i32> {
    let attribute = cfstr(attribute);
    let value = cfstr(value);
    let error = unsafe {
        AXUIElementSetAttributeValue(
            el_ref(el),
            attribute.as_concrete_TypeRef(),
            value.as_CFTypeRef(),
        )
    };
    if error == kAXErrorSuccess {
        Ok(())
    } else {
        Err(error)
    }
}

pub fn set_selected_text_range(el: &AXUIElement, start: usize, end: usize) -> Result<(), i32> {
    let range = CFRange::init(start as isize, end.saturating_sub(start) as isize);
    let value = unsafe {
        AXValueCreate(
            kAXValueTypeCFRange,
            (&range as *const CFRange).cast::<c_void>(),
        )
    };
    if value.is_null() {
        return Err(accessibility_sys::kAXErrorFailure);
    }
    let attribute = cfstr("AXSelectedTextRange");
    let error = unsafe {
        AXUIElementSetAttributeValue(
            el_ref(el),
            attribute.as_concrete_TypeRef(),
            value as CFTypeRef,
        )
    };
    unsafe {
        CFRelease(value as CFTypeRef);
    }
    if error == kAXErrorSuccess {
        Ok(())
    } else {
        Err(error)
    }
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
    let dict =
        cf_ax::dictionary::CFDictionary::from_CFType_pairs(&[(key.as_CFType(), val.as_CFType())]);
    unsafe {
        AXIsProcessTrustedWithOptions(dict.as_concrete_TypeRef() as CFDictionaryRef);
    }
}

/// Set a boolean attribute to true. Best-effort: unsupported / illegal-argument
/// errors on native apps are expected and ignored.
fn set_bool_attr(el: &AXUIElement, name: &str) {
    let attr = cfstr(name);
    unsafe {
        AXUIElementSetAttributeValue(
            el_ref(el),
            attr.as_concrete_TypeRef(),
            kCFBooleanTrue as CFTypeRef,
        );
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
    let err =
        unsafe { AXUIElementCopyAttributeValue(el_ref(el), attr.as_concrete_TypeRef(), &mut out) };
    if err != kAXErrorSuccess || out.is_null() {
        return None;
    }
    // Copy semantics → we own a +1 reference; `wrap_under_create_rule` takes it.
    Some(unsafe { AXUIElement::wrap_under_create_rule(out as AXUIElementRef) })
}

pub fn focused_ui_element(app: &AXUIElement) -> Option<AXUIElement> {
    copy_element_attr(app, "AXFocusedUIElement")
}

/// The system-wide AX element — the root for global queries.
fn system_wide() -> AXUIElement {
    unsafe { AXUIElement::wrap_under_create_rule(AXUIElementCreateSystemWide()) }
}

/// The pid of the frontmost application, via AX rather than AppKit.
///
/// The obvious implementation is `NSWorkspace.frontmostApplication`, but this
/// crate deliberately carries no `objc2-app-kit`, and the other obvious one
/// (`osascript`) forks a process. `AXFocusedApplication` on the system-wide
/// element is a single mach round-trip and needs only the Accessibility grant
/// we already hold.
pub fn system_wide_focused_pid() -> Option<u32> {
    let focused = copy_element_attr(&system_wide(), "AXFocusedApplication")?;
    element_pid(&focused)
}

/// Owning process of an element.
pub fn element_pid(element: &AXUIElement) -> Option<u32> {
    let mut pid: i32 = 0;
    let err = unsafe { AXUIElementGetPid(el_ref(element), &mut pid) };
    (err == kAXErrorSuccess && pid > 0).then_some(pid as u32)
}

/// Cap how long a single AX message may block.
///
/// The observer run loop services every application on the desktop; one hung
/// or hostile app must not be able to wedge it. macOS has no global default
/// here, so this has to be set per application element we talk to.
pub fn set_messaging_timeout(element: &AXUIElement, seconds: f32) {
    unsafe {
        AXUIElementSetMessagingTimeout(el_ref(element), seconds);
    }
}

/// Length of the selected text range, in characters.
///
/// `Some(0)` genuinely means "the selection is now empty" and is distinct from
/// `None`, which means the element exposes no selection at all.
pub fn selected_text_range_length(element: &AXUIElement) -> Option<i64> {
    let attr = cfstr("AXSelectedTextRange");
    let mut out: CFTypeRef = std::ptr::null();
    let err = unsafe {
        AXUIElementCopyAttributeValue(el_ref(element), attr.as_concrete_TypeRef(), &mut out)
    };
    if err != kAXErrorSuccess || out.is_null() {
        return None;
    }
    let value = unsafe { cf_ax::base::CFType::wrap_under_create_rule(out) };
    let mut range = CFRange::init(0, 0);
    let ok = unsafe {
        AXValueGetValue(
            value.as_CFTypeRef() as AXValueRef,
            kAXValueTypeCFRange,
            (&mut range as *mut CFRange).cast::<c_void>(),
        )
    };
    ok.then_some(range.length as i64)
}

/// True hit-test: the deepest element at a screen point.
///
/// Screen coordinates with a top-left origin — the same space `CGEvent`
/// reports mouse locations in, so a click position can be passed straight
/// through.
pub fn element_at_position(x: f32, y: f32) -> Option<AXUIElement> {
    let mut out: AXUIElementRef = std::ptr::null_mut();
    let err = unsafe {
        AXUIElementCopyElementAtPosition(
            el_ref(&system_wide()),
            x,
            y,
            &mut out as *mut AXUIElementRef,
        )
    };
    if err != kAXErrorSuccess || out.is_null() {
        return None;
    }
    Some(unsafe { AXUIElement::wrap_under_create_rule(out) })
}

/// How far up the AX ancestor chain `web_area_url` will walk. Deep enough to
/// escape a nested editor, shallow enough that a pathological tree cannot turn
/// one selection into hundreds of cross-process messages.
const WEB_AREA_ANCESTOR_LIMIT: usize = 12;

/// The document URL of the web area containing this element, if any.
///
/// AX only — deliberately NOT AppleScript. `tell application "Google Chrome"
/// to get URL` triggers the Apple Events (Automation) TCC prompt *once per
/// target application*, so a user selecting text in three browsers would be
/// asked for three new permissions. Reading `AXURL` off the `AXWebArea` needs
/// nothing beyond the Accessibility grant the feature already requires.
pub fn web_area_url(element: &AXUIElement) -> Option<String> {
    let mut current = element.clone();
    for _ in 0..WEB_AREA_ANCESTOR_LIMIT {
        if current.role().ok().is_some_and(|role| role == "AXWebArea") {
            return read_url_string(&current);
        }
        current = copy_element_attr(&current, "AXParent")?;
    }
    None
}

/// `AXURL` is a CFURL on Chromium and WebKit, but a few hosts hand back a
/// plain string — accept either rather than silently losing the page context.
fn read_url_string(el: &AXUIElement) -> Option<String> {
    let attr = cfstr("AXURL");
    let mut out: CFTypeRef = std::ptr::null();
    let err =
        unsafe { AXUIElementCopyAttributeValue(el_ref(el), attr.as_concrete_TypeRef(), &mut out) };
    if err != kAXErrorSuccess || out.is_null() {
        return None;
    }
    let value = unsafe { cf_ax::base::CFType::wrap_under_create_rule(out) };
    if let Some(url) = value.downcast::<cf_ax::url::CFURL>() {
        return Some(url.get_string().to_string()).filter(|s| !s.is_empty());
    }
    value
        .downcast::<CFString>()
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
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

/// Whether the currently focused control is a secure text field.
///
/// Process-name matching catches dedicated password managers and OS prompts,
/// but a browser or native app can host its own password field. AX exposes
/// those controls with the `AXSecureTextField` subrole, so treat that signal as
/// authoritative without reading the field's value.
pub fn focused_element_is_secure_text_field(app: &AXUIElement) -> bool {
    focused_ui_element(app)
        .and_then(|element| element.subrole().ok())
        .is_some_and(|subrole| subrole == "AXSecureTextField")
}

pub fn selected_text(element: &AXUIElement) -> Option<String> {
    let attr = cfstr("AXSelectedText");
    let mut out: CFTypeRef = std::ptr::null();
    let err = unsafe {
        AXUIElementCopyAttributeValue(el_ref(element), attr.as_concrete_TypeRef(), &mut out)
    };
    if err != kAXErrorSuccess || out.is_null() {
        return None;
    }
    let value = unsafe { cf_ax::base::CFType::wrap_under_create_rule(out) };
    value
        .downcast::<CFString>()
        .map(|text| text.to_string())
        .filter(|text| !text.trim().is_empty())
}

pub fn selected_text_bounds(element: &AXUIElement) -> Option<Rect> {
    let range_attr = cfstr("AXSelectedTextRange");
    let mut range_out: CFTypeRef = std::ptr::null();
    let range_err = unsafe {
        AXUIElementCopyAttributeValue(
            el_ref(element),
            range_attr.as_concrete_TypeRef(),
            &mut range_out,
        )
    };
    if range_err != kAXErrorSuccess || range_out.is_null() {
        return None;
    }
    let range_value = unsafe { cf_ax::base::CFType::wrap_under_create_rule(range_out) };

    // AXBoundsForRange returns the union of a multi-line selection. Anchor the
    // toolbar to the final selected character first so the overlay follows the
    // selection tail; fall back to the full range for controls that reject a
    // one-character parameter.
    let mut selected_range = CFRange::init(0, 0);
    let has_range = unsafe {
        AXValueGetValue(
            range_value.as_CFTypeRef() as AXValueRef,
            kAXValueTypeCFRange,
            (&mut selected_range as *mut CFRange).cast::<c_void>(),
        )
    };
    if has_range && selected_range.length > 0 {
        let tail_range = CFRange::init(selected_range.location + selected_range.length - 1, 1);
        let tail_value = unsafe {
            AXValueCreate(
                kAXValueTypeCFRange,
                (&tail_range as *const CFRange).cast::<c_void>(),
            )
        };
        if !tail_value.is_null() {
            let tail_value =
                unsafe { cf_ax::base::CFType::wrap_under_create_rule(tail_value as CFTypeRef) };
            if let Some(bounds) = bounds_for_range(element, tail_value.as_CFTypeRef()) {
                return Some(bounds);
            }
        }
    }
    bounds_for_range(element, range_value.as_CFTypeRef())
}

fn bounds_for_range(element: &AXUIElement, range: CFTypeRef) -> Option<Rect> {
    let bounds_attr = cfstr("AXBoundsForRange");
    let mut bounds_out: CFTypeRef = std::ptr::null();
    let bounds_err = unsafe {
        AXUIElementCopyParameterizedAttributeValue(
            el_ref(element),
            bounds_attr.as_concrete_TypeRef(),
            range,
            &mut bounds_out,
        )
    };
    if bounds_err != kAXErrorSuccess || bounds_out.is_null() {
        return None;
    }
    let bounds_value = unsafe { cf_ax::base::CFType::wrap_under_create_rule(bounds_out) };
    let mut rect = CGRect::default();
    let ok = unsafe {
        AXValueGetValue(
            bounds_value.as_CFTypeRef() as AXValueRef,
            kAXValueTypeCGRect,
            (&mut rect as *mut CGRect).cast::<c_void>(),
        )
    };
    if !ok {
        return None;
    }
    Some(Rect {
        x: rect.origin.x.round() as i32,
        y: rect.origin.y.round() as i32,
        width: rect.size.width.round() as i32,
        height: rect.size.height.round() as i32,
    })
}

/// Read `AXValue` as a string when it is one (text fields, static text). Returns
/// `None` for non-string values (sliders, checkboxes) or absent attributes.
pub fn read_value_string(el: &AXUIElement) -> Option<String> {
    let attr = cfstr("AXValue");
    let mut out: CFTypeRef = std::ptr::null();
    let err =
        unsafe { AXUIElementCopyAttributeValue(el_ref(el), attr.as_concrete_TypeRef(), &mut out) };
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
    let err =
        unsafe { AXUIElementCopyAttributeValue(el_ref(el), attr.as_concrete_TypeRef(), &mut out) };
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
    let err =
        unsafe { AXUIElementCopyAttributeValue(el_ref(el), attr.as_concrete_TypeRef(), &mut out) };
    if err != kAXErrorSuccess || out.is_null() {
        return None;
    }
    let mut p = CGPoint { x: 0.0, y: 0.0 };
    let ok = unsafe {
        AXValueGetValue(
            out as AXValueRef,
            kAXValueTypeCGPoint,
            &mut p as *mut _ as *mut c_void,
        )
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
    let err =
        unsafe { AXUIElementCopyAttributeValue(el_ref(el), attr.as_concrete_TypeRef(), &mut out) };
    if err != kAXErrorSuccess || out.is_null() {
        return None;
    }
    let mut s = CGSize {
        width: 0.0,
        height: 0.0,
    };
    let ok = unsafe {
        AXValueGetValue(
            out as AXValueRef,
            kAXValueTypeCGSize,
            &mut s as *mut _ as *mut c_void,
        )
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
