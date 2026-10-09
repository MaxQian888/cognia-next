//! AX FFI for the macOS backend.
//!
//! Everything that touches `AXUIElement` goes through [`AxElement`], a retained
//! element over `objc2-application-services`, so the rest of the backend never
//! handles a raw pointer or an `AXError`. Beyond the plain string attributes and
//! children, three things are needed for a *useful* element tree — all
//! diagnosed against real apps (Chrome, VS Code) during the ADR-0020 macOS
//! follow-up:
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
//!      CGSize, unwrapped here.
//!
//! Ownership follows the Create/Copy rule through `CFRetained`: every `Copy*`
//! out-parameter is adopted with `from_raw` (+1 already held) and released on
//! drop, so no path here calls `CFRelease` by hand. Values whose CF type is not
//! guaranteed by the attribute (`AXValue`, `AXURL`, array items) are checked with
//! a `downcast` before use rather than assumed.

use std::ffi::c_void;
use std::ptr::NonNull;

use objc2_application_services::{
    kAXTrustedCheckOptionPrompt, AXError, AXIsProcessTrusted, AXIsProcessTrustedWithOptions,
    AXUIElement, AXValue, AXValueType,
};
use objc2_core_foundation::{
    CFArray, CFBoolean, CFDictionary, CFIndex, CFNumber, CFRange, CFRetained, CFString, CFType,
    CGPoint, CGRect, CGSize, CFURL,
};

use crate::automation::types::Rect;

/// A retained accessibility element.
///
/// Cloning retains; dropping releases. Not `Send`: AX elements are used on the
/// thread that read them, exactly as the backend worker and the observer
/// thread already do.
#[derive(Clone)]
pub struct AxElement(CFRetained<AXUIElement>);

impl std::fmt::Debug for AxElement {
    /// Identity only: formatting attributes would mean AX round-trips (and
    /// could print a secure field's contents into a log).
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("AxElement")
            .field(&format_args!("{:#x}", self.identity()))
            .finish()
    }
}

impl AxElement {
    /// The application element for `pid`. Never fails: a dead pid yields an
    /// element whose every read errors, which callers already treat as absent.
    pub fn application(pid: u32) -> Self {
        // SAFETY: `AXUIElementCreateApplication` accepts any pid and returns a
        // +1 element (the binding adopts it).
        Self(unsafe { AXUIElement::new_application(pid as i32) })
    }

    /// The system-wide element — the root for global queries.
    fn system_wide() -> Self {
        // SAFETY: no preconditions; returns a +1 element.
        Self(unsafe { AXUIElement::new_system_wide() })
    }

    /// Adopt a +1 element handed back through a `Copy*` out-parameter.
    ///
    /// # Safety
    /// `ptr` must be null or a valid `AXUIElementRef` the caller owns.
    unsafe fn from_copied(ptr: *const AXUIElement) -> Option<Self> {
        NonNull::new(ptr.cast_mut()).map(|ptr| Self(unsafe { CFRetained::from_raw(ptr) }))
    }

    /// Retain an element borrowed from a callback (Get rule).
    ///
    /// # Safety
    /// `ptr` must point to a live `AXUIElement` for the duration of the call.
    pub(super) unsafe fn retain_borrowed(ptr: NonNull<AXUIElement>) -> Self {
        Self(unsafe { CFRetained::retain(ptr) })
    }

    /// The underlying CF object, for the observer's registration calls.
    pub(super) fn as_ax(&self) -> &AXUIElement {
        &self.0
    }

    /// Pointer identity — two handles are the same element exactly when they
    /// wrap the same `AXUIElementRef`.
    pub fn identity(&self) -> usize {
        CFRetained::as_ptr(&self.0).as_ptr() as usize
    }

    /// Copy an attribute value. `None` for any AX error (absent, unsupported,
    /// timed out, API disabled) or a null value.
    fn copy_attribute(&self, name: &str) -> Option<CFRetained<CFType>> {
        let attribute = CFString::from_str(name);
        let mut out: *const CFType = std::ptr::null();
        // SAFETY: `out` is a valid out-parameter; on success it holds a +1 value.
        let error = unsafe {
            self.0
                .copy_attribute_value(&attribute, NonNull::from(&mut out))
        };
        if error != AXError::Success {
            return None;
        }
        NonNull::new(out.cast_mut()).map(|ptr| unsafe { CFRetained::from_raw(ptr) })
    }

    /// A string attribute, trimmed of nothing but required to be non-empty —
    /// an empty `AXTitle` carries no more information than an absent one.
    pub fn string_attribute(&self, name: &str) -> Option<String> {
        let value = self.copy_attribute(name)?;
        let string = value.downcast_ref::<CFString>()?.to_string();
        (!string.is_empty()).then_some(string)
    }

    /// An element-valued attribute (`AXParent`, `AXFocusedWindow`, …).
    fn element_attribute(&self, name: &str) -> Option<AxElement> {
        self.copy_attribute(name)?
            .downcast::<AXUIElement>()
            .ok()
            .map(AxElement)
    }

    /// An array-of-elements attribute (`AXWindows`, `AXChildren`). Items that
    /// are not elements are skipped rather than reinterpreted.
    fn element_array_attribute(&self, name: &str) -> Option<Vec<AxElement>> {
        let value = self.copy_attribute(name)?;
        let array = value.downcast_ref::<CFArray>()?;
        Some(elements_of(array))
    }

    /// How many values an array attribute holds, without copying them.
    fn attribute_count(&self, name: &str) -> Option<usize> {
        let attribute = CFString::from_str(name);
        let mut count: CFIndex = 0;
        // SAFETY: `count` is a valid out-parameter.
        let error = unsafe {
            self.0
                .attribute_value_count(&attribute, NonNull::from(&mut count))
        };
        (error == AXError::Success && count >= 0).then_some(count as usize)
    }

    pub fn role(&self) -> Option<String> {
        self.string_attribute("AXRole")
    }

    pub fn subrole(&self) -> Option<String> {
        self.string_attribute("AXSubrole")
    }

    pub fn title(&self) -> Option<String> {
        self.string_attribute("AXTitle")
    }

    pub fn description(&self) -> Option<String> {
        self.string_attribute("AXDescription")
    }

    pub fn role_description(&self) -> Option<String> {
        self.string_attribute("AXRoleDescription")
    }

    pub fn identifier(&self) -> Option<String> {
        self.string_attribute("AXIdentifier")
    }

    /// `AXWindows`, or `None` when the application exposes none.
    pub fn windows(&self) -> Option<Vec<AxElement>> {
        self.element_array_attribute("AXWindows")
    }

    /// Whether `AXChildren` is non-empty, read as a count so a 10k-child web
    /// area is not copied just to answer yes.
    pub fn has_children(&self) -> bool {
        self.attribute_count("AXChildren")
            .is_some_and(|count| count > 0)
    }
}

/// Every `AXUIElement` in a CF array, skipping any other item type.
fn elements_of(array: &CFArray) -> Vec<AxElement> {
    // SAFETY: every CFArray item is a CF object, so viewing the items as
    // `CFType` is sound; each one is then type-checked by `downcast`.
    let items = unsafe { array.cast_unchecked::<CFType>() };
    items
        .iter()
        .filter_map(|item| item.downcast::<AXUIElement>().ok().map(AxElement))
        .collect()
}

pub fn element_identity(el: &AxElement) -> usize {
    el.identity()
}

/// The element's `AXParent`, or `None` at the top of the hierarchy.
///
/// Needed to build a locator recipe for an element we were handed rather than
/// walked down to (`find`, `pick_at_point`, `get_focus`): the recipe is a path
/// from the window root, so it has to be reconstructed upwards.
pub fn parent(el: &AxElement) -> Option<AxElement> {
    el.element_attribute("AXParent")
}

/// Read only the requested AXChildren slice. Copying the whole `AXChildren`
/// array before the traversal can apply its node budget is unsafe for 10k+
/// node WebView/Electron trees.
pub fn read_children_page(el: &AxElement, offset: usize, limit: usize) -> Vec<AxElement> {
    if limit == 0 {
        return Vec::new();
    }
    let Some(count) = el.attribute_count("AXChildren") else {
        return Vec::new();
    };
    if count == 0 || offset >= count {
        return Vec::new();
    }
    let page_size = limit.min(count - offset);
    let attribute = CFString::from_str("AXChildren");
    let mut values: *const CFArray = std::ptr::null();
    // SAFETY: `values` is a valid out-parameter; on success it holds a +1 array.
    let error = unsafe {
        el.0.copy_attribute_values(
            &attribute,
            offset as CFIndex,
            page_size as CFIndex,
            NonNull::from(&mut values),
        )
    };
    if error != AXError::Success {
        return Vec::new();
    }
    let Some(values) = NonNull::new(values.cast_mut()) else {
        return Vec::new();
    };
    let values = unsafe { CFRetained::from_raw(values) };
    elements_of(&values)
}

fn ax_result(error: AXError) -> Result<(), i32> {
    if error == AXError::Success {
        Ok(())
    } else {
        Err(error.0)
    }
}

pub fn perform_action(el: &AxElement, action: &str) -> Result<(), i32> {
    let action = CFString::from_str(action);
    // SAFETY: both arguments are valid CF objects.
    ax_result(unsafe { el.0.perform_action(&action) })
}

pub fn set_string_value(el: &AxElement, attribute: &str, value: &str) -> Result<(), i32> {
    let attribute = CFString::from_str(attribute);
    let value = CFString::from_str(value);
    // SAFETY: both arguments are valid CF objects.
    ax_result(unsafe { el.0.set_attribute_value(&attribute, &value) })
}

/// Wrap a `CFRange` as the `AXValue` AX expects for range attributes and
/// parameters.
fn range_value(range: CFRange) -> Option<CFRetained<AXValue>> {
    // SAFETY: `AXValueCreate` copies the pointed-to `CFRange`, whose layout
    // matches `AXValueType::CFRange`.
    unsafe { AXValue::new(AXValueType::CFRange, NonNull::from(&range).cast()) }
}

mod sealed {
    pub trait Sealed {}
}

/// A struct an `AXValue` can wrap, tied to its `AXValueType` so a read can
/// never pair a type with the wrong size.
///
/// # Safety
/// `Self` must have exactly the C layout `AXValueGetValue` writes for `KIND`.
unsafe trait AxStruct: sealed::Sealed + Copy {
    const KIND: AXValueType;
    fn zeroed() -> Self;
}

macro_rules! ax_struct {
    ($ty:ty, $kind:expr, $zero:expr) => {
        impl sealed::Sealed for $ty {}
        // SAFETY: the `objc2-core-foundation` struct is the `repr(C)` mirror of
        // the CoreGraphics / CoreFoundation type `$kind` stores.
        unsafe impl AxStruct for $ty {
            const KIND: AXValueType = $kind;
            fn zeroed() -> Self {
                $zero
            }
        }
    };
}

ax_struct!(CGPoint, AXValueType::CGPoint, CGPoint::default());
ax_struct!(CGSize, AXValueType::CGSize, CGSize::default());
ax_struct!(CGRect, AXValueType::CGRect, CGRect::default());
ax_struct!(CFRange, AXValueType::CFRange, CFRange::new(0, 0));

/// Unwrap an `AXValue` holding a `T`. `None` when the value is not an
/// `AXValue` or holds a different type.
fn ax_value_get<T: AxStruct>(value: &CFType) -> Option<T> {
    let value = value.downcast_ref::<AXValue>()?;
    let mut out = T::zeroed();
    // SAFETY: `out` is a writable `T` whose layout matches `T::KIND`
    // (`AxStruct`'s contract); `AXValueGetValue` checks the stored type and
    // writes nothing on a mismatch.
    let ok = unsafe { value.value(T::KIND, NonNull::from(&mut out).cast::<c_void>()) };
    ok.then_some(out)
}

pub fn set_selected_text_range(el: &AxElement, start: usize, end: usize) -> Result<(), i32> {
    let range = CFRange::new(start as CFIndex, end.saturating_sub(start) as CFIndex);
    let Some(value) = range_value(range) else {
        return Err(AXError::Failure.0);
    };
    let attribute = CFString::from_str("AXSelectedTextRange");
    // SAFETY: both arguments are valid CF objects.
    ax_result(unsafe { el.0.set_attribute_value(&attribute, &value) })
}

/// Whether this process is trusted for the Accessibility API. When false, every
/// AX read against another process returns `kAXErrorAPIDisabled`, so `read_tree`
/// would silently observe an empty tree.
pub fn is_trusted() -> bool {
    // SAFETY: no preconditions.
    unsafe { AXIsProcessTrusted() }
}

/// Best-effort: pop the system "grant Accessibility permission" prompt. A no-op
/// if already trusted. Uses
/// `AXIsProcessTrustedWithOptions({ AXTrustedCheckOptionPrompt: true })`.
pub fn prompt_trust() {
    // SAFETY: an immutable framework constant.
    let key: &CFString = unsafe { kAXTrustedCheckOptionPrompt };
    let options = CFDictionary::<CFString, CFBoolean>::from_slices(&[key], &[CFBoolean::new(true)]);
    // SAFETY: `options` is a valid dictionary of the documented key/value types.
    unsafe {
        AXIsProcessTrustedWithOptions(Some(options.as_opaque()));
    }
}

/// Set a boolean attribute to true. Best-effort: unsupported / illegal-argument
/// errors on native apps are expected and ignored.
fn set_bool_attr(el: &AxElement, name: &str) {
    let attribute = CFString::from_str(name);
    // SAFETY: both arguments are valid CF objects.
    let _ = unsafe { el.0.set_attribute_value(&attribute, CFBoolean::new(true)) };
}

/// Ask a Chromium / WebKit / Electron application to expose its web-content
/// accessibility tree. WebKit honours `AXManualAccessibility`; Chromium /
/// Electron honour `AXEnhancedUserInterface`. Harmless no-op on native apps.
pub fn activate_web_a11y(app: &AxElement) {
    set_bool_attr(app, "AXManualAccessibility");
    set_bool_attr(app, "AXEnhancedUserInterface");
}

pub fn focused_ui_element(app: &AxElement) -> Option<AxElement> {
    app.element_attribute("AXFocusedUIElement")
}

/// The pid of the frontmost application, via AX rather than AppKit.
///
/// `NSWorkspace.frontmostApplication` would need an autorelease pool and the
/// main-thread-sensitive AppKit surface on the observer's hot path, and
/// `osascript` forks a process. `AXFocusedApplication` on the system-wide
/// element is a single mach round-trip and needs only the Accessibility grant
/// we already hold.
pub fn system_wide_focused_pid() -> Option<u32> {
    let focused = AxElement::system_wide().element_attribute("AXFocusedApplication")?;
    element_pid(&focused)
}

/// Owning process of an element.
pub fn element_pid(element: &AxElement) -> Option<u32> {
    let mut pid: i32 = 0; // `pid_t` is `i32` on Darwin.
                          // SAFETY: `pid` is a valid out-parameter.
    let error = unsafe { element.0.pid(NonNull::from(&mut pid)) };
    (error == AXError::Success && pid > 0).then_some(pid as u32)
}

/// Cap how long a single AX message may block.
///
/// The observer run loop services every application on the desktop; one hung
/// or hostile app must not be able to wedge it. macOS has no global default
/// here, so this has to be set per application element we talk to.
pub fn set_messaging_timeout(element: &AxElement, seconds: f32) {
    // SAFETY: valid element; any timeout value is accepted.
    let _ = unsafe { element.0.set_messaging_timeout(seconds) };
}

/// The `AXSelectedTextRange` value, still wrapped.
fn selected_range_value(element: &AxElement) -> Option<CFRetained<CFType>> {
    element.copy_attribute("AXSelectedTextRange")
}

/// Length of the selected text range, in characters.
///
/// `Some(0)` genuinely means "the selection is now empty" and is distinct from
/// `None`, which means the element exposes no selection at all.
pub fn selected_text_range_length(element: &AxElement) -> Option<i64> {
    let value = selected_range_value(element)?;
    ax_value_get::<CFRange>(&value).map(|range| range.length as i64)
}

/// True hit-test: the deepest element at a screen point.
///
/// Screen coordinates with a top-left origin — the same space `CGEvent`
/// reports mouse locations in, so a click position can be passed straight
/// through.
pub fn element_at_position(x: f32, y: f32) -> Option<AxElement> {
    let mut out: *const AXUIElement = std::ptr::null();
    // SAFETY: `out` is a valid out-parameter; on success it holds a +1 element.
    let error = unsafe {
        AxElement::system_wide()
            .0
            .copy_element_at_position(x, y, NonNull::from(&mut out))
    };
    if error != AXError::Success {
        return None;
    }
    // SAFETY: success hands back an owned element or null.
    unsafe { AxElement::from_copied(out) }
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
pub fn web_area_url(element: &AxElement) -> Option<String> {
    let mut current = element.clone();
    for _ in 0..WEB_AREA_ANCESTOR_LIMIT {
        if current.role().is_some_and(|role| role == "AXWebArea") {
            return read_url_string(&current);
        }
        current = parent(&current)?;
    }
    None
}

/// `AXURL` is a CFURL on Chromium and WebKit, but a few hosts hand back a
/// plain string — accept either rather than silently losing the page context.
fn read_url_string(el: &AxElement) -> Option<String> {
    let value = el.copy_attribute("AXURL")?;
    let text = if let Some(url) = value.downcast_ref::<CFURL>() {
        url.string().to_string()
    } else {
        value.downcast_ref::<CFString>()?.to_string()
    };
    (!text.is_empty()).then_some(text)
}

/// Resolve the window `read_tree` should root at: the focused window, then the
/// main window, then the first window that actually has children (skips
/// empty helper windows), then the first window, then the application element
/// itself.
pub fn resolve_window_root(app: &AxElement) -> AxElement {
    if let Some(window) = app.element_attribute("AXFocusedWindow") {
        return window;
    }
    if let Some(window) = app.element_attribute("AXMainWindow") {
        return window;
    }
    if let Some(windows) = app.windows() {
        if let Some(window) = windows.iter().find(|window| window.has_children()) {
            return window.clone();
        }
        if let Some(first) = windows.into_iter().next() {
            return first;
        }
    }
    app.clone()
}

/// Whether the app currently exposes at least one window. Used to decide if a
/// just-issued `activate_web_a11y` needs a settle delay before the tree is
/// readable.
pub fn has_visible_windows(app: &AxElement) -> bool {
    app.attribute_count("AXWindows")
        .is_some_and(|count| count > 0)
}

/// Whether the currently focused control is a secure text field.
///
/// Process-name matching catches dedicated password managers and OS prompts,
/// but a browser or native app can host its own password field. AX exposes
/// those controls with the `AXSecureTextField` subrole, so treat that signal as
/// authoritative without reading the field's value.
pub fn focused_element_is_secure_text_field(app: &AxElement) -> bool {
    focused_ui_element(app)
        .and_then(|element| element.subrole())
        .is_some_and(|subrole| subrole == "AXSecureTextField")
}

pub fn selected_text(element: &AxElement) -> Option<String> {
    element
        .string_attribute("AXSelectedText")
        .filter(|text| !text.trim().is_empty())
}

pub fn selected_text_bounds(element: &AxElement) -> Option<Rect> {
    let selected = selected_range_value(element)?;

    // AXBoundsForRange returns the union of a multi-line selection. Anchor the
    // toolbar to the final selected character first so the overlay follows the
    // selection tail; fall back to the full range for controls that reject a
    // one-character parameter — or answer it with a zero-width rect, which is
    // what a trailing newline gets, usually at the start of the *next* line.
    if let Some(selected_range) =
        ax_value_get::<CFRange>(&selected).filter(|range| range.length > 0)
    {
        let tail = CFRange::new(selected_range.location + selected_range.length - 1, 1);
        if let Some(tail_value) = range_value(tail) {
            if let Some(bounds) = bounds_for_range(element, &tail_value)
                .filter(|bounds| bounds.width > 0 && bounds.height > 0)
            {
                return Some(bounds);
            }
        }
    }
    // A rect with no height is no anchor at all (Chromium answers "unknown"
    // with an empty rect at the origin); report none and let the caller fall
    // back to the pointer.
    bounds_for_range(element, &selected).filter(|bounds| bounds.height > 0)
}

fn bounds_for_range(element: &AxElement, range: &CFType) -> Option<Rect> {
    let attribute = CFString::from_str("AXBoundsForRange");
    let mut out: *const CFType = std::ptr::null();
    // SAFETY: valid arguments; on success `out` holds a +1 value.
    let error = unsafe {
        element
            .0
            .copy_parameterized_attribute_value(&attribute, range, NonNull::from(&mut out))
    };
    if error != AXError::Success {
        return None;
    }
    let bounds = unsafe { CFRetained::from_raw(NonNull::new(out.cast_mut())?) };
    let rect = ax_value_get::<CGRect>(&bounds)?;
    Some(Rect {
        x: rect.origin.x.round() as i32,
        y: rect.origin.y.round() as i32,
        width: rect.size.width.round() as i32,
        height: rect.size.height.round() as i32,
    })
}

/// Read `AXValue` as a string when it is one (text fields, static text). Returns
/// `None` for non-string values (sliders, checkboxes) or absent attributes.
pub fn read_value_string(el: &AxElement) -> Option<String> {
    el.string_attribute("AXValue")
}

/// Read a boolean attribute (`AXEnabled` / `AXFocused`). `None` when absent or
/// not boolean-like; a few hosts report these as a CFNumber 0/1.
pub fn read_bool(el: &AxElement, name: &str) -> Option<bool> {
    let value = el.copy_attribute(name)?;
    bool_from_value(&value)
}

fn bool_from_value(value: &CFType) -> Option<bool> {
    if let Some(boolean) = value.downcast_ref::<CFBoolean>() {
        return Some(boolean.as_bool());
    }
    value
        .downcast_ref::<CFNumber>()
        .and_then(CFNumber::as_i64)
        .map(|number| number != 0)
}

/// Element bounding rect in global (screen) coordinates from `AXPosition` +
/// `AXSize`. `None` when either is absent (menus, some transient elements).
pub fn read_rect(el: &AxElement) -> Option<Rect> {
    let position = el.copy_attribute("AXPosition")?;
    let origin = ax_value_get::<CGPoint>(&position)?;
    let extent = el.copy_attribute("AXSize")?;
    let size = ax_value_get::<CGSize>(&extent)?;
    Some(Rect {
        x: origin.x.round() as i32,
        y: origin.y.round() as i32,
        width: size.width.round() as i32,
        height: size.height.round() as i32,
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

    #[test]
    fn a_range_round_trips_through_an_ax_value() {
        let value = range_value(CFRange::new(7, 3)).expect("AXValueCreate");
        let range = ax_value_get::<CFRange>(&value).expect("a CFRange value");
        assert_eq!((range.location, range.length), (7, 3));
    }

    #[test]
    fn an_ax_value_of_another_type_is_not_read_as_a_rect() {
        // A CFRange-typed value must not be reinterpreted as a CGRect, and a
        // non-AXValue (a string) must not be read at all.
        let value = range_value(CFRange::new(1, 1)).expect("AXValueCreate");
        assert!(ax_value_get::<CGRect>(&value).is_none());
        let not_a_value = CFString::from_str("AXPosition");
        assert!(ax_value_get::<CGRect>(&not_a_value).is_none());
    }

    #[test]
    fn booleans_read_from_cf_booleans_and_numbers_only() {
        assert_eq!(bool_from_value(CFBoolean::new(true)), Some(true));
        assert_eq!(bool_from_value(CFBoolean::new(false)), Some(false));
        // Some hosts report AXEnabled / AXFocused as a CFNumber 0/1.
        assert_eq!(bool_from_value(&CFNumber::new_i32(1)), Some(true));
        assert_eq!(bool_from_value(&CFNumber::new_i32(0)), Some(false));
        // Anything else is "absent", so callers fall back to their default
        // instead of reading a string as `false`.
        assert_eq!(bool_from_value(&CFString::from_str("true")), None);
    }

    #[test]
    fn element_arrays_skip_items_that_are_not_elements() {
        let app = AxElement::application(std::process::id());
        let text = CFString::from_str("not an element");
        let array = CFArray::<CFType>::from_objects(&[app.as_ax().as_ref(), text.as_ref()]);
        let elements = elements_of(array.as_opaque());
        assert_eq!(elements.len(), 1);
        assert_eq!(elements[0].identity(), app.identity());
    }

    #[test]
    fn identity_is_stable_across_clones_and_distinct_between_elements() {
        let app = AxElement::application(std::process::id());
        assert_eq!(app.clone().identity(), app.identity());
        assert_ne!(AxElement::system_wide().identity(), app.identity());
    }

    #[test]
    fn a_dead_pid_reads_as_absent_not_as_an_error() {
        // No process owns this pid, so every AX read fails; the wrapper must
        // turn each failure into "absent" rather than panic or invent data.
        let app = AxElement::application(999_999);
        assert_eq!(app.role(), None);
        assert!(app.windows().is_none());
        assert!(!app.has_children());
        assert!(read_children_page(&app, 0, 10).is_empty());
        assert_eq!(element_pid(&app), Some(999_999));
        assert_eq!(read_rect(&app), None);
        assert_eq!(read_bool(&app, "AXEnabled"), None);
        assert_eq!(resolve_window_root(&app).identity(), app.identity());
    }
}
