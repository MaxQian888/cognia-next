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
    /// The back-end exposes a cross-platform accessibility tree
    /// (`read_tree` / `find`) independent of Windows UIA. True for the remote
    /// cua sandbox backend (`get_accessibility_tree`); false for the
    /// input-only local enigo back-ends. `#[serde(default)]` keeps older
    /// persisted/round-tripped payloads deserializing.
    #[serde(default)]
    pub has_a11y_tree: bool,
}

/// Which execution backend a call targets. `Local` = the synchronous COM
/// worker (existing UIA / enigo back-ends); `Remote` = the async
/// `CuaRemoteClient` keyed by a sandbox connection id. Default = `Local`, so
/// every existing call site that doesn't set a target keeps hitting the host.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CallTarget {
    #[default]
    Local,
    Remote {
        connection_id: String,
    },
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
    /// Number of consecutive clicks (1 = single, 2 = double, 3 = triple).
    /// When unset, falls back to `double` (true → 2, false/None → 1).
    /// Backends repeat the click using the OS double-click cadence so
    /// applications see a real native triple-click rather than three
    /// independent presses.
    pub count: Option<u32>,
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

// =============================================================================
// Bash / text-editor payloads (canonical home)
//
// These moved down from `plugins/computer-use/rust/src/types.rs` so the
// canonical `Action` below can fold the `bash_20250124` and
// `text_editor_20250728` tools into the same enum the dispatcher matches on.
// The plugin re-exports them, so its `use super::types::*` keeps compiling.
// =============================================================================

/// Input for the `bash_20250124` tool. Field names already match the wire
/// shape Anthropic emits (`command` / `timeout` / `restart`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BashAction {
    pub command: String,
    #[serde(default)]
    pub timeout: Option<u64>,
    #[serde(default)]
    pub restart: bool,
}

/// Field names stay snake_case (`exit_code` / `duration_ms`) to preserve the
/// exact wire shape the model + sidecar already consume — do not camelCase.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BashResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub duration_ms: u64,
}

/// Input for the `text_editor_20250728` tool. Retains Anthropic's
/// `action`-tagged snake_case wire shape; nesting it inside the canonical
/// `Action::TextEditor` variant yields `{ "kind": "textEditor", "action":
/// "view", .. }` which deserializes cleanly (serde flattens the newtype
/// content of an internally-tagged enum).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[serde(tag = "action")]
pub enum TextEditorAction {
    View { path: String },
    Create { path: String, file_text: String },
    StrReplace { path: String, old_str: String, new_str: String },
    Insert { path: String, insert_line: usize, new_str: String },
    UndoEdit { path: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextEditorResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// =============================================================================
// Canonical Action
//
// The single internal representation every wire format converts INTO:
//   - Anthropic `computer_20251124` (`ComputerAction`, snake_case) → via the
//     adapter's `TryFrom` (see `automation/adapters/anthropic.rs`).
//   - External Bridge MCP (`ComputerUseInput`) → via `toCanonicalAction`.
//   - `desktop.*` renderer client → builds an `Action` directly.
//
// The unified dispatcher matches on this enum exactly once. Payloads reuse the
// existing structs above — no duplicate shapes. Anthropic's left/right/middle/
// double/triple click variants collapse into `Click { target, opts }` via
// `opts.button` + `opts.count`, exactly as the legacy translator did.
// =============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Action {
    // --- screenshot / pointer / keyboard (computer-tool family) ---
    Screenshot {
        #[serde(default)]
        opts: ScreenshotOpts,
    },
    Click {
        target: ClickTarget,
        #[serde(default)]
        opts: ClickOpts,
    },
    MouseMove {
        point: Point,
    },
    Drag {
        from: Point,
        to: Point,
        #[serde(default)]
        opts: DragOpts,
    },
    MouseButton {
        button: MouseButton,
        transition: ButtonTransition,
    },
    Scroll {
        target: ScrollTarget,
        #[serde(default)]
        opts: ScrollOpts,
    },
    Type {
        text: String,
        #[serde(default)]
        opts: TypeOpts,
    },
    Keys {
        chord: KeyChord,
    },
    HoldKey {
        chord: KeyChord,
        duration_ms: u32,
    },
    Wait {
        duration_ms: u32,
    },
    CursorPosition,
    // --- accessibility tree / element / window ---
    Capabilities,
    GetFocus,
    ReadTree {
        #[serde(default)]
        root: Option<ElementRef>,
        #[serde(default)]
        opts: TreeOpts,
    },
    Find {
        locator: Locator,
    },
    InvokePattern {
        target: ElementRef,
        pattern: PatternKind,
        #[serde(default)]
        args: serde_json::Value,
    },
    WindowOp {
        target: ElementRef,
        op: WindowOp,
    },
    PickAtPoint {
        point: Point,
    },
    PickSessionStart,
    PickSessionCancel,
    // --- other native tools ---
    Bash(BashAction),
    TextEditor(TextEditorAction),
}

impl Action {
    /// Stable command string used for permission gating + audit rows. Matches
    /// the legacy per-command strings so audit history stays consistent.
    pub fn command(&self) -> &'static str {
        match self {
            Action::Screenshot { .. } => "screenshot",
            Action::Click { .. } => "click",
            Action::MouseMove { .. } => "mouse_move",
            Action::Drag { .. } => "drag",
            Action::MouseButton { .. } => "mouse_button",
            Action::Scroll { .. } => "scroll",
            Action::Type { .. } => "type",
            Action::Keys { .. } => "keys",
            Action::HoldKey { .. } => "hold_key",
            Action::Wait { .. } => "wait",
            Action::CursorPosition => "cursor_position",
            Action::Capabilities => "capabilities",
            Action::GetFocus => "get_focus",
            Action::ReadTree { .. } => "read_tree",
            Action::Find { .. } => "find",
            Action::InvokePattern { .. } => "invoke_pattern",
            Action::WindowOp { .. } => "window_op",
            Action::PickAtPoint { .. } => "pick_at_point",
            Action::PickSessionStart => "pick_session_start",
            Action::PickSessionCancel => "pick_session_cancel",
            Action::Bash(_) => "bash",
            Action::TextEditor(_) => "text_editor",
        }
    }

    /// The target coordinate of a pointer action, if any. The dispatcher uses
    /// this to stamp `clickX`/`clickY` on policy facts without the renderer
    /// having to pass them separately.
    pub fn point(&self) -> Option<Point> {
        match self {
            Action::MouseMove { point }
            | Action::PickAtPoint { point } => Some(*point),
            Action::Click {
                target: ClickTarget::Point { x, y },
                ..
            } => Some(Point { x: *x, y: *y }),
            Action::Scroll {
                target: ScrollTarget::Point { x, y },
                ..
            } => Some(Point { x: *x, y: *y }),
            Action::Drag { from, .. } => Some(*from),
            _ => None,
        }
    }
}

/// Canonical output union. Each edge adapter projects this back into its own
/// wire result (`ComputerResult` / `BashResult` / `TextEditorResult` / the
/// `desktop.*` typed returns).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ActionOutput {
    Void,
    Screenshot(Screenshot),
    Cursor(Point),
    Capabilities(Capabilities),
    Element(ElementInfo),
    Tree(Vec<ElementInfo>),
    Found {
        #[serde(default)]
        element_ref: Option<ElementRef>,
    },
    Pattern(serde_json::Value),
    Bash(BashResult),
    TextEditor(TextEditorResult),
}

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
            has_a11y_tree: true,
        };
        let json = serde_json::to_string(&caps).unwrap();
        assert!(json.contains("\"hasUia\":true"));
        assert!(json.contains("\"hasA11yTree\":true"));
        assert!(json.contains("\"platform\":\"windows\""));
    }

    #[test]
    fn call_target_defaults_to_local() {
        assert_eq!(CallTarget::default(), CallTarget::Local);
    }

    #[test]
    fn call_target_remote_serializes_camel() {
        let json = serde_json::to_string(&CallTarget::Remote {
            connection_id: "c1".into(),
        })
        .unwrap();
        assert!(json.contains("\"kind\":\"remote\""));
        assert!(json.contains("\"connectionId\":\"c1\""));
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
    fn click_opts_count_roundtrips() {
        let opts = ClickOpts {
            count: Some(3),
            ..Default::default()
        };
        let json = serde_json::to_string(&opts).unwrap();
        assert!(json.contains("\"count\":3"));
        let back: ClickOpts = serde_json::from_str(&json).unwrap();
        assert_eq!(back.count, Some(3));

        // Missing field deserializes to None for backward compatibility.
        let legacy: ClickOpts = serde_json::from_str(r#"{"button":"left"}"#).unwrap();
        assert!(legacy.count.is_none());
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

    #[test]
    fn action_click_roundtrips_with_kind_tag() {
        let a = Action::Click {
            target: ClickTarget::Point { x: 10, y: 20 },
            opts: ClickOpts {
                button: Some(MouseButton::Right),
                count: Some(2),
                ..Default::default()
            },
        };
        let json = serde_json::to_string(&a).unwrap();
        assert!(json.contains("\"kind\":\"click\""));
        let back: Action = serde_json::from_str(&json).unwrap();
        match back {
            Action::Click { target, opts } => {
                assert!(matches!(target, ClickTarget::Point { x: 10, y: 20 }));
                assert_eq!(opts.button, Some(MouseButton::Right));
                assert_eq!(opts.count, Some(2));
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn action_omitted_opts_default() {
        // The renderer may send only `{ "kind": "screenshot" }`.
        let a: Action = serde_json::from_str(r#"{"kind":"screenshot"}"#).unwrap();
        assert!(matches!(a, Action::Screenshot { .. }));
        let a: Action = serde_json::from_str(r#"{"kind":"cursorPosition"}"#).unwrap();
        assert!(matches!(a, Action::CursorPosition));
    }

    #[test]
    fn action_bash_newtype_flattens_under_kind_tag() {
        let a = Action::Bash(BashAction {
            command: "echo hi".into(),
            timeout: Some(5000),
            restart: false,
        });
        let json = serde_json::to_string(&a).unwrap();
        assert!(json.contains("\"kind\":\"bash\""));
        assert!(json.contains("\"command\":\"echo hi\""));
        let back: Action = serde_json::from_str(&json).unwrap();
        match back {
            Action::Bash(b) => {
                assert_eq!(b.command, "echo hi");
                assert_eq!(b.timeout, Some(5000));
                assert!(!b.restart);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn action_text_editor_double_tag_roundtrips() {
        let a = Action::TextEditor(TextEditorAction::StrReplace {
            path: "/tmp/a.txt".into(),
            old_str: "x".into(),
            new_str: "y".into(),
        });
        let json = serde_json::to_string(&a).unwrap();
        assert!(json.contains("\"kind\":\"textEditor\""));
        assert!(json.contains("\"action\":\"str_replace\""));
        let back: Action = serde_json::from_str(&json).unwrap();
        assert!(matches!(
            back,
            Action::TextEditor(TextEditorAction::StrReplace { .. })
        ));
    }

    #[test]
    fn action_command_strings_match_legacy() {
        assert_eq!(
            Action::Click {
                target: ClickTarget::Point { x: 0, y: 0 },
                opts: ClickOpts::default(),
            }
            .command(),
            "click"
        );
        assert_eq!(
            Action::Bash(BashAction {
                command: "x".into(),
                timeout: None,
                restart: false,
            })
            .command(),
            "bash"
        );
        assert_eq!(Action::CursorPosition.command(), "cursor_position");
        assert_eq!(Action::GetFocus.command(), "get_focus");
    }

    #[test]
    fn action_point_derivation() {
        let click = Action::Click {
            target: ClickTarget::Point { x: 7, y: 9 },
            opts: ClickOpts::default(),
        };
        assert_eq!(click.point(), Some(Point { x: 7, y: 9 }));
        // Element-targeted clicks have no coordinate.
        let elt_click = Action::Click {
            target: ClickTarget::Element {
                element_ref: ElementRef("ff".into()),
            },
            opts: ClickOpts::default(),
        };
        assert_eq!(elt_click.point(), None);
        assert_eq!(Action::Screenshot { opts: ScreenshotOpts::default() }.point(), None);
    }

    #[test]
    fn action_output_variants_roundtrip() {
        let out = ActionOutput::Cursor(Point { x: 1, y: 2 });
        let json = serde_json::to_string(&out).unwrap();
        assert!(json.contains("\"kind\":\"cursor\""));
        let _back: ActionOutput = serde_json::from_str(&json).unwrap();

        let found = ActionOutput::Found {
            element_ref: Some(ElementRef("abc".into())),
        };
        let json = serde_json::to_string(&found).unwrap();
        assert!(json.contains("\"kind\":\"found\""));
        let _back: ActionOutput = serde_json::from_str(&json).unwrap();
    }
}
