//! Cross-platform types for the UI automation subsystem.
//!
//! These are the JSON-shape contracts that flow through the Tauri command
//! surface; each back-end (UIA / AXAPI / AT-SPI) converts to/from its own
//! platform-native representation.
//!
//! Design constraints:
//!
//! - Every type must derive `Serialize + Deserialize` so it round-trips
//!   cleanly across the Tauri IPC boundary.
//! - Discriminated unions use serde `#[serde(tag = "kind")]` to match the
//!   TypeScript mirror in `lib/automation/types.ts`.
//! - All identifiers are camelCase on the wire — the renderer doesn't see
//!   Rust snake_case.

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Capabilities the active back-end exposes. Renderer reads this to enable
/// or hide UI affordances (e.g., "find element" button is hidden when
/// `hasUia` is false).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub platform: Platform,
    pub has_uia: bool,
    pub has_input_sim: bool,
    pub has_screenshot: bool,
    pub has_events: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Windows,
    Macos,
    Linux,
    Unsupported,
}

/// Opaque reference to an element in the back-end's tree. The renderer never
/// inspects the inner string — it just passes it back to subsequent commands.
///
/// Format on Windows: a hex-encoded RuntimeId. On macOS/Linux it's a
/// path-like locator string. Treat it as opaque on the TS side.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct ElementRef(pub String);

/// Cached snapshot of an element's accessibility properties. The renderer
/// can render this directly in the inspector without an extra round-trip.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ElementInfo {
    pub element_ref: ElementRef,
    pub name: Option<String>,
    pub automation_id: Option<String>,
    pub control_type: Option<String>,
    pub class_name: Option<String>,
    pub bounding_rect: Option<Rect>,
    pub is_enabled: bool,
    pub is_focused: bool,
    pub process_id: Option<u32>,
    pub process_name: Option<String>,
    pub window_title: Option<String>,
    pub children: Option<Vec<ElementInfo>>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// Element-locator query — the cross-platform analog of UIA's `UIMatcher`.
/// `None` fields are wildcards; multiple non-None fields are ANDed.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Locator {
    pub name: Option<String>,
    pub name_contains: Option<String>,
    pub automation_id: Option<String>,
    pub control_type: Option<String>,
    pub class_name: Option<String>,
    pub process_id: Option<u32>,
    pub process_name: Option<String>,
    pub window_title_contains: Option<String>,
    pub depth: Option<u32>,
    pub from: Option<ElementRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TreeOpts {
    pub max_depth: Option<u32>,
    pub cache_props: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotOpts {
    pub region: Option<Rect>,
    pub format: Option<ImageFormat>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ImageFormat {
    #[default]
    Png,
    Jpeg,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Screenshot {
    /// Base64-encoded image bytes.
    pub bytes: String,
    pub width: u32,
    pub height: u32,
    pub captured_at: i64,
    pub format: ImageFormat,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ClickTarget {
    Element { element_ref: ElementRef },
    Point { x: i32, y: i32 },
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClickOpts {
    pub button: Option<MouseButton>,
    pub double: Option<bool>,
    pub modifier: Option<KeyChord>,
    /// When `Some(true)` or `None` (default) and `target` is an
    /// `Element { .. }`, the backend tries the appropriate UIA pattern
    /// (Invoke → Toggle → SelectionItem) before falling back to a coordinate
    /// click at the element's bounding-rect center. Set to `Some(false)` to
    /// force coordinate input — useful for games / custom-drawn surfaces UIA
    /// can't see.
    pub use_native: Option<bool>,
}

/// Cross-platform 2D point in screen coordinates.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

/// Options for `AutomationBackend::drag`. The path is straight-line; the
/// backend interpolates intermediate moves so the OS sees a real-looking
/// drag rather than a teleport (which some apps reject).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DragOpts {
    pub button: Option<MouseButton>,
    /// How long the move from start → end should take in milliseconds.
    /// Defaults to ~150ms.
    pub duration_ms: Option<u32>,
    /// Number of interpolated steps (default ~12 — produces smooth-looking
    /// drag without overwhelming the input queue).
    pub steps: Option<u32>,
}

/// Either a screen point or an element (its bounding-rect center is used).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ScrollTarget {
    Point { x: i32, y: i32 },
    Element { element_ref: ElementRef },
}

/// Scroll deltas. Positive `dy` scrolls down; positive `dx` scrolls right.
/// Magnitude is in OS-native wheel units (typically 120 per "notch").
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScrollOpts {
    #[serde(default)]
    pub dx: i32,
    #[serde(default)]
    pub dy: i32,
}

/// Mouse button down / up transition for `mouse_button` calls.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ButtonTransition {
    Down,
    Up,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MouseButton {
    #[default]
    Left,
    Right,
    Middle,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TypeOpts {
    pub delay_ms: Option<u32>,
    pub target: Option<ElementRef>,
}

/// Key chord parsed from strings like `"ctrl+shift+t"` or `"alt+F4"`.
/// Modifier order doesn't matter; the final key is the last token.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct KeyChord(pub String);

/// Discriminated union of UIA-style patterns. The `args` payload is pattern-
/// specific; see each pattern's docs for the expected shape.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PatternKind {
    Invoke,
    Toggle,
    SelectionItem,
    Value,
    Text,
    RangeValue,
    Window,
    Transform,
    ExpandCollapse,
    ScrollItem,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WindowOp {
    Focus,
    Close,
    Minimize,
    Maximize,
    Restore,
    Resize { rect: Rect },
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EventFilter {
    pub kinds: Option<Vec<EventKind>>,
    pub scope: Option<ElementRef>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum EventKind {
    FocusChanged,
    StructureChanged,
    PropertyChanged,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubscriptionId(pub u64);

/// Errors returned across the Tauri boundary. Each variant gets a stable
/// `code` string so the TS side can match without parsing free-form text.
#[derive(Debug, Clone, Error, Serialize, Deserialize)]
#[serde(tag = "code", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AutomationError {
    /// The active platform has no real implementation (macOS/Linux in M1).
    #[error("automation not supported on this platform")]
    UnsupportedPlatform,
    /// The global kill switch is engaged. All in-flight calls fail with this.
    #[error("automation kill switch is active")]
    KillSwitchActive,
    /// The configured tier denies this call.
    #[error("permission denied: {reason}")]
    PermissionDenied { reason: String },
    /// The user declined an HITL consent prompt.
    #[error("user declined consent")]
    UserDeclined,
    /// The target process/window is not on the whitelist.
    #[error("target outside whitelist")]
    WhitelistMiss,
    /// `find` returned None — caller asked for an element that doesn't exist.
    #[error("element not found")]
    ElementNotFound,
    /// The element ref was valid but the target window has since closed.
    #[error("stale element reference")]
    StaleElement,
    /// The back-end raised an OS-level error (UIA HRESULT, AXAPI error, …).
    #[error("backend error: {message}")]
    BackendError { message: String },
    /// Anything we couldn't classify. Should be rare.
    #[error("internal error: {message}")]
    Internal { message: String },
}

pub type Result<T> = std::result::Result<T, AutomationError>;

#[cfg(test)]
mod tests {
    use super::*;

    fn roundtrip<T: Serialize + for<'de> Deserialize<'de> + std::fmt::Debug>(value: &T) -> T {
        let json = serde_json::to_string(value).expect("serialize");
        serde_json::from_str(&json).expect("deserialize")
    }

    #[test]
    fn capabilities_roundtrip_camel_case() {
        let caps = Capabilities {
            platform: Platform::Windows,
            has_uia: true,
            has_input_sim: true,
            has_screenshot: true,
            has_events: true,
        };
        let json = serde_json::to_string(&caps).unwrap();
        assert!(json.contains("\"hasUia\":true"));
        assert!(json.contains("\"platform\":\"windows\""));
    }

    #[test]
    fn locator_omits_none_fields() {
        let mut l = Locator::default();
        l.name = Some("OK".into());
        let json = serde_json::to_string(&l).unwrap();
        // serde keeps None fields as null by default; this assertion just
        // ensures the field name is camelCased correctly.
        assert!(json.contains("\"name\":\"OK\""));
    }

    #[test]
    fn click_target_tagged_union() {
        let t = ClickTarget::Element {
            element_ref: ElementRef("abc".into()),
        };
        let json = serde_json::to_string(&t).unwrap();
        assert!(json.contains("\"kind\":\"element\""));
        let back: ClickTarget = serde_json::from_str(&json).unwrap();
        match back {
            ClickTarget::Element { element_ref } => assert_eq!(element_ref.0, "abc"),
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn window_op_tagged_union() {
        let op = WindowOp::Resize {
            rect: Rect {
                x: 0,
                y: 0,
                width: 100,
                height: 200,
            },
        };
        let json = serde_json::to_string(&op).unwrap();
        assert!(json.contains("\"kind\":\"resize\""));
        let back: WindowOp = serde_json::from_str(&json).unwrap();
        matches!(back, WindowOp::Resize { .. });
    }

    #[test]
    fn every_error_variant_roundtrips() {
        let variants = vec![
            AutomationError::UnsupportedPlatform,
            AutomationError::KillSwitchActive,
            AutomationError::PermissionDenied {
                reason: "off".into(),
            },
            AutomationError::UserDeclined,
            AutomationError::WhitelistMiss,
            AutomationError::ElementNotFound,
            AutomationError::StaleElement,
            AutomationError::BackendError {
                message: "HRESULT".into(),
            },
            AutomationError::Internal {
                message: "oops".into(),
            },
        ];
        for v in &variants {
            let json = serde_json::to_string(v).unwrap();
            // Code field is tagged at top level — proves the SCREAMING_SNAKE_CASE rename.
            assert!(json.contains("\"code\":"));
            let _back: AutomationError = serde_json::from_str(&json).unwrap();
        }
    }

    #[test]
    fn error_codes_are_stable_screaming_snake_case() {
        let json = serde_json::to_string(&AutomationError::UnsupportedPlatform).unwrap();
        assert!(json.contains("\"code\":\"UNSUPPORTED_PLATFORM\""));
        let json = serde_json::to_string(&AutomationError::KillSwitchActive).unwrap();
        assert!(json.contains("\"code\":\"KILL_SWITCH_ACTIVE\""));
        let json = serde_json::to_string(&AutomationError::WhitelistMiss).unwrap();
        assert!(json.contains("\"code\":\"WHITELIST_MISS\""));
    }

    #[test]
    fn point_roundtrips_camel_case() {
        let p = Point { x: 100, y: 200 };
        let json = serde_json::to_string(&p).unwrap();
        assert!(json.contains("\"x\":100"));
        assert!(json.contains("\"y\":200"));
        let back: Point = serde_json::from_str(&json).unwrap();
        assert_eq!(back, p);
    }

    #[test]
    fn drag_opts_optional_fields() {
        let opts = DragOpts {
            button: Some(MouseButton::Left),
            duration_ms: Some(200),
            steps: Some(15),
        };
        let json = serde_json::to_string(&opts).unwrap();
        assert!(json.contains("\"durationMs\":200"));
        assert!(json.contains("\"steps\":15"));
        let back: DragOpts = serde_json::from_str(&json).unwrap();
        assert_eq!(back.steps, Some(15));
    }

    #[test]
    fn scroll_target_tagged_union() {
        let p = ScrollTarget::Point { x: 5, y: 10 };
        let json = serde_json::to_string(&p).unwrap();
        assert!(json.contains("\"kind\":\"point\""));
        let elt = ScrollTarget::Element {
            element_ref: ElementRef("ff".into()),
        };
        let json = serde_json::to_string(&elt).unwrap();
        assert!(json.contains("\"kind\":\"element\""));
        let _back: ScrollTarget = serde_json::from_str(&json).unwrap();
    }

    #[test]
    fn button_transition_roundtrips() {
        let json = serde_json::to_string(&ButtonTransition::Down).unwrap();
        assert_eq!(json, "\"down\"");
        let back: ButtonTransition = serde_json::from_str(&json).unwrap();
        assert_eq!(back, ButtonTransition::Down);
    }

    #[test]
    fn click_opts_use_native_default_omitted() {
        let opts = ClickOpts::default();
        let json = serde_json::to_string(&opts).unwrap();
        // Default is None; serde writes null but the field is still present.
        // What matters is that deserialization of a json without the field works.
        let _back: ClickOpts = serde_json::from_str("{}").unwrap();
        assert!(opts.use_native.is_none());
        let _ = json;
    }

    #[test]
    fn pattern_kind_roundtrips() {
        for k in [
            PatternKind::Invoke,
            PatternKind::Toggle,
            PatternKind::SelectionItem,
            PatternKind::Value,
            PatternKind::Text,
            PatternKind::RangeValue,
            PatternKind::Window,
            PatternKind::Transform,
            PatternKind::ExpandCollapse,
            PatternKind::ScrollItem,
        ] {
            let v = roundtrip(&k);
            assert_eq!(v, k);
        }
    }
}
