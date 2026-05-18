//! The cross-platform `AutomationBackend` trait. Each platform module
//! (`platform::uia` / `platform::ax` / `platform::atspi`) implements this;
//! the worker thread owns one implementation behind a trait object.
//!
//! Methods are intentionally synchronous and blocking — the worker thread
//! takes care of marshalling requests onto a stable OS thread (which, on
//! Windows, owns the COM apartment).

use super::types::*;

pub trait AutomationBackend {
    fn capabilities(&self) -> Capabilities;
    fn get_focus(&self) -> Result<ElementInfo>;
    fn read_tree(&self, root: Option<ElementRef>, opts: TreeOpts) -> Result<Vec<ElementInfo>>;
    fn find(&self, locator: &Locator) -> Result<Option<ElementRef>>;
    fn screenshot(&self, opts: ScreenshotOpts) -> Result<Screenshot>;
    fn click(&self, target: ClickTarget, opts: ClickOpts) -> Result<()>;
    fn type_text(&self, text: &str, opts: TypeOpts) -> Result<()>;
    fn send_keys(&self, chord: &KeyChord) -> Result<()>;
    fn invoke_pattern(
        &self,
        target: ElementRef,
        pattern: PatternKind,
        args: serde_json::Value,
    ) -> Result<serde_json::Value>;
    fn window_op(&self, target: ElementRef, op: WindowOp) -> Result<()>;
    fn subscribe_events(&self, filter: EventFilter) -> Result<SubscriptionId>;
    fn unsubscribe(&self, sub: SubscriptionId) -> Result<()>;

    // ── M5 completion: pointer + key primitives required by Anthropic
    // `computer_20251124`. The trait owns these so workflow nodes and MCP
    // tools share one implementation across platforms.

    /// Move the cursor to absolute screen coordinates without pressing any
    /// button. Used by `computer_use({ action: "mouse_move", ... })`.
    fn mouse_move(&self, point: Point) -> Result<()>;

    /// Press a mouse button, drag to a destination, release. The backend is
    /// expected to interpolate intermediate moves so apps that look at the
    /// move trace (e.g., drag-and-drop sources) see a real-looking gesture.
    fn drag(&self, from: Point, to: Point, opts: DragOpts) -> Result<()>;

    /// Scroll by `(dx, dy)` deltas at the given target. Positive `dy`
    /// scrolls down. For `ScrollTarget::Element`, the backend should try the
    /// element's `ScrollPattern` / `ScrollItemPattern` first, then fall back
    /// to wheel events at the element's bounding-rect center.
    fn scroll(&self, target: ScrollTarget, opts: ScrollOpts) -> Result<()>;

    /// Press a key chord, hold for `duration_ms`, release. Used to drive
    /// holdable hotkeys (e.g., a 1-second `LeftShift` to enable sticky-keys).
    fn hold_key(&self, chord: &KeyChord, duration_ms: u32) -> Result<()>;

    /// Press or release a mouse button without moving the cursor. Combined
    /// with `mouse_move`, this lets the caller compose custom gestures.
    fn mouse_button(
        &self,
        button: MouseButton,
        transition: ButtonTransition,
    ) -> Result<()>;

    /// Read the current cursor position in screen coordinates. Read-only —
    /// driving-call classification does not apply. Used by
    /// `computer_use({ action: "cursor_position" })`.
    fn cursor_position(&self) -> Result<Point>;

    /// Resolve the topmost UI element at screen coordinates. Read-only.
    /// Backs the Inspector "Pick" affordance: the renderer overlay
    /// captures a point and calls this to materialise an `ElementInfo`.
    ///
    /// macOS / Linux return `UnsupportedPlatform` until equivalent
    /// AXUIElement / AT-SPI hit-testing ships (Phase 6.b).
    fn pick_at_point(&self, point: Point) -> Result<ElementInfo>;
}

/// A back-end that fails every call with `UnsupportedPlatform`. macOS and
/// Linux ship with this in M1; M3 swaps in real implementations.
pub struct StubBackend {
    pub platform: Platform,
}

impl AutomationBackend for StubBackend {
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            platform: self.platform,
            has_uia: false,
            has_input_sim: false,
            has_screenshot: false,
            has_events: false,
        }
    }
    fn get_focus(&self) -> Result<ElementInfo> {
        Err(AutomationError::UnsupportedPlatform)
    }
    fn read_tree(&self, _r: Option<ElementRef>, _o: TreeOpts) -> Result<Vec<ElementInfo>> {
        Err(AutomationError::UnsupportedPlatform)
    }
    fn find(&self, _l: &Locator) -> Result<Option<ElementRef>> {
        Err(AutomationError::UnsupportedPlatform)
    }
    fn screenshot(&self, _o: ScreenshotOpts) -> Result<Screenshot> {
        Err(AutomationError::UnsupportedPlatform)
    }
    fn click(&self, _t: ClickTarget, _o: ClickOpts) -> Result<()> {
        Err(AutomationError::UnsupportedPlatform)
    }
    fn type_text(&self, _text: &str, _o: TypeOpts) -> Result<()> {
        Err(AutomationError::UnsupportedPlatform)
    }
    fn send_keys(&self, _c: &KeyChord) -> Result<()> {
        Err(AutomationError::UnsupportedPlatform)
    }
    fn invoke_pattern(
        &self,
        _t: ElementRef,
        _p: PatternKind,
        _a: serde_json::Value,
    ) -> Result<serde_json::Value> {
        Err(AutomationError::UnsupportedPlatform)
    }
    fn window_op(&self, _t: ElementRef, _o: WindowOp) -> Result<()> {
        Err(AutomationError::UnsupportedPlatform)
    }
    fn subscribe_events(&self, _f: EventFilter) -> Result<SubscriptionId> {
        Err(AutomationError::UnsupportedPlatform)
    }
    fn unsubscribe(&self, _s: SubscriptionId) -> Result<()> {
        Err(AutomationError::UnsupportedPlatform)
    }
    fn mouse_move(&self, _p: Point) -> Result<()> {
        Err(AutomationError::UnsupportedPlatform)
    }
    fn drag(&self, _f: Point, _t: Point, _o: DragOpts) -> Result<()> {
        Err(AutomationError::UnsupportedPlatform)
    }
    fn scroll(&self, _t: ScrollTarget, _o: ScrollOpts) -> Result<()> {
        Err(AutomationError::UnsupportedPlatform)
    }
    fn hold_key(&self, _c: &KeyChord, _d: u32) -> Result<()> {
        Err(AutomationError::UnsupportedPlatform)
    }
    fn mouse_button(
        &self,
        _b: MouseButton,
        _t: ButtonTransition,
    ) -> Result<()> {
        Err(AutomationError::UnsupportedPlatform)
    }
    fn cursor_position(&self) -> Result<Point> {
        Err(AutomationError::UnsupportedPlatform)
    }
    fn pick_at_point(&self, _p: Point) -> Result<ElementInfo> {
        Err(AutomationError::UnsupportedPlatform)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stub_backend_reports_unsupported() {
        let b = StubBackend {
            platform: Platform::Macos,
        };
        let caps = b.capabilities();
        assert_eq!(caps.platform, Platform::Macos);
        assert!(!caps.has_uia);
        assert!(matches!(
            b.get_focus(),
            Err(AutomationError::UnsupportedPlatform)
        ));
        assert!(matches!(
            b.find(&Locator::default()),
            Err(AutomationError::UnsupportedPlatform)
        ));
        assert!(matches!(
            b.screenshot(ScreenshotOpts::default()),
            Err(AutomationError::UnsupportedPlatform)
        ));
    }

    #[test]
    fn stub_backend_new_methods_are_unsupported() {
        let b = StubBackend {
            platform: Platform::Linux,
        };
        assert!(matches!(
            b.mouse_move(Point { x: 0, y: 0 }),
            Err(AutomationError::UnsupportedPlatform)
        ));
        assert!(matches!(
            b.drag(
                Point { x: 0, y: 0 },
                Point { x: 10, y: 10 },
                DragOpts::default()
            ),
            Err(AutomationError::UnsupportedPlatform)
        ));
        assert!(matches!(
            b.scroll(
                ScrollTarget::Point { x: 0, y: 0 },
                ScrollOpts { dx: 0, dy: 120 }
            ),
            Err(AutomationError::UnsupportedPlatform)
        ));
        assert!(matches!(
            b.hold_key(&KeyChord("shift".into()), 100),
            Err(AutomationError::UnsupportedPlatform)
        ));
        assert!(matches!(
            b.mouse_button(MouseButton::Left, ButtonTransition::Down),
            Err(AutomationError::UnsupportedPlatform)
        ));
        assert!(matches!(
            b.cursor_position(),
            Err(AutomationError::UnsupportedPlatform)
        ));
        assert!(matches!(
            b.pick_at_point(Point { x: 0, y: 0 }),
            Err(AutomationError::UnsupportedPlatform)
        ));
    }
}
