//! The cross-platform `AutomationBackend` trait. Each platform module
//! (`platform::uia` / `platform::ax` / `platform::atspi`) implements this;
//! the worker thread owns one implementation behind a trait object.
//!
//! Methods are intentionally synchronous and blocking — the worker thread
//! takes care of marshalling requests onto a stable OS thread (which, on
//! Windows, owns the COM apartment).

use super::selection::TextSelectionSnapshot;
use super::session::{AppLocator, ResolvedApplication};
use super::types::*;

#[derive(Debug, Clone)]
pub struct ApplicationScreenshot {
    pub screenshot: Screenshot,
    pub window_id: Option<u64>,
    pub display_id: Option<String>,
    pub logical_bounds: Rect,
    pub scale_factor: f64,
}

pub trait AutomationBackend {
    fn capabilities(&self) -> Capabilities;
    fn get_focus(&self) -> Result<ElementInfo>;
    fn list_applications(&self) -> Result<Vec<ResolvedApplication>> {
        let focus = self.get_focus()?;
        Ok(vec![ResolvedApplication {
            bundle_id: None,
            path: None,
            display_name: focus.process_name.unwrap_or_else(|| "Unknown".into()),
            process_id: focus.process_id.unwrap_or_default(),
        }])
    }
    fn read_tree(&self, root: Option<ElementRef>, opts: TreeOpts) -> Result<Vec<ElementInfo>>;
    fn read_application_tree(
        &self,
        app: &ResolvedApplication,
        opts: TreeOpts,
    ) -> Result<Vec<ElementInfo>> {
        let focus = self.get_focus()?;
        if focus.process_id != Some(app.process_id) {
            return Err(AutomationError::BackendError {
                message: format!(
                    "application {} is not focused and this backend cannot read it in the background",
                    app.display_name
                ),
            });
        }
        self.read_tree(None, opts)
    }
    fn find(&self, locator: &Locator) -> Result<Option<ElementRef>>;
    fn screenshot(&self, opts: ScreenshotOpts) -> Result<Screenshot>;
    fn screenshot_application(
        &self,
        app: &ResolvedApplication,
        window_hint: Option<&ElementInfo>,
        opts: ScreenshotOpts,
    ) -> Result<ApplicationScreenshot> {
        let focus = self.get_focus()?;
        if focus.process_id != Some(app.process_id) {
            return Err(AutomationError::BackendError {
                message: format!(
                    "application {} is not foreground for screenshot capture",
                    app.display_name
                ),
            });
        }
        let screenshot = self.screenshot(opts)?;

        // `self.screenshot(..)` captures a whole monitor, not this
        // application's window. Reporting the *window's* rect as
        // `logical_bounds` while `pixel_width` / `pixel_height` describe the
        // whole screen makes `session::pixel_to_global_point` rescale every
        // model-supplied coordinate through the wrong rectangle: the model
        // reads a point off a full-screen frame and the backend lands it
        // somewhere inside the window's bounds instead. That is a silent,
        // systematic click offset — no error, just the wrong place — so
        // describe the surface actually captured and let the caller see that
        // this platform has no per-window capture yet.
        //
        // macOS overrides this method with a real ScreenCaptureKit
        // per-window stream; Windows and Linux land here.
        let capabilities = self.capabilities();
        let monitor = capabilities
            .monitors
            .iter()
            .find(|candidate| candidate.is_primary)
            .or_else(|| capabilities.monitors.first());
        let scale_factor = monitor
            .map(|candidate| f64::from(candidate.scale_factor))
            .filter(|scale| *scale > 0.0)
            .unwrap_or(1.0);
        let to_logical = |value: f64| (value / scale_factor).round() as i32;
        let logical_bounds = monitor.map_or(
            Rect {
                x: 0,
                y: 0,
                width: i32::try_from(screenshot.width).unwrap_or(i32::MAX),
                height: i32::try_from(screenshot.height).unwrap_or(i32::MAX),
            },
            |candidate| Rect {
                x: to_logical(f64::from(candidate.x)),
                y: to_logical(f64::from(candidate.y)),
                width: to_logical(f64::from(candidate.width)),
                height: to_logical(f64::from(candidate.height)),
            },
        );
        // The window rect is deliberately unused: keeping it would reintroduce
        // the mismatch above. It stays in the signature because the macOS
        // override uses it to pick which window to stream.
        let _ = window_hint;
        Ok(ApplicationScreenshot {
            screenshot,
            window_id: None,
            display_id: monitor.map(|candidate| candidate.id.clone()),
            logical_bounds,
            scale_factor,
        })
    }

    /// Resolve and, when explicitly allowed, prepare the application whose
    /// state will be captured. Platform backends override this when they can
    /// resolve bundle IDs and paths; the default supports the already-focused
    /// application by display name without launching anything.
    fn resolve_application(
        &self,
        locator: &AppLocator,
        allow_launch: bool,
    ) -> Result<ResolvedApplication> {
        if allow_launch {
            return Err(AutomationError::UnsupportedPlatform);
        }
        let focus = self.get_focus()?;
        let display_name =
            focus
                .process_name
                .clone()
                .ok_or_else(|| AutomationError::BackendError {
                    message: "focused application did not expose a process name".into(),
                })?;
        match locator {
            AppLocator::DisplayName {
                display_name: requested,
            } if requested.eq_ignore_ascii_case(&display_name) => Ok(ResolvedApplication {
                bundle_id: None,
                path: None,
                display_name,
                process_id: focus.process_id.unwrap_or_default(),
            }),
            AppLocator::DisplayName {
                display_name: requested,
            } => Err(AutomationError::BackendError {
                message: format!(
                    "requested application {requested:?} is not focused (focused: {display_name:?})"
                ),
            }),
            AppLocator::BundleId { .. } | AppLocator::Path { .. } => {
                Err(AutomationError::UnsupportedPlatform)
            }
        }
    }

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
    fn mouse_button(&self, button: MouseButton, transition: ButtonTransition) -> Result<()>;

    /// Read the current cursor position in screen coordinates. Read-only —
    /// driving-call classification does not apply. Used by
    /// `computer_use({ action: "cursor_position" })`.
    fn cursor_position(&self) -> Result<Point>;

    /// Resolve the topmost UI element at screen coordinates. Read-only.
    /// Backs the Inspector "Pick" affordance: the renderer overlay
    /// captures a point and calls this to materialise an `ElementInfo`.
    ///
    /// Windows hit-tests through UIA. Linux resolves the window under
    /// the cursor via xdotool (falling back to the focused window).
    /// macOS resolves the frontmost window via osascript metadata —
    /// true AXUIElement hit-testing is still Phase 6.b.
    fn pick_at_point(&self, point: Point) -> Result<ElementInfo>;

    /// Read the currently focused text selection without changing application
    /// state. Backends that cannot expose native text ranges return
    /// `UnsupportedPlatform`; an accessible control with no active selection
    /// returns `Ok(None)`.
    fn read_text_selection(&self) -> Result<Option<TextSelectionSnapshot>> {
        Err(AutomationError::UnsupportedPlatform)
    }

    /// Cheap "who has focus, and may we read from it" probe.
    ///
    /// Exists so a caller can decide whether a selection read is worth doing
    /// *before* paying for one. The selection toolbar used to read the
    /// selection first and only then check the app against its blocklist,
    /// which meant password managers and disabled apps still cost a full AX
    /// round-trip — and, on macOS, an `osascript` fork — on every click.
    ///
    /// Backends that cannot answer return `UnsupportedPlatform`; callers must
    /// treat that as "no opinion" and fall back to their existing checks
    /// rather than as a refusal.
    fn selection_preflight(&self) -> Result<SelectionPreflight> {
        Err(AutomationError::UnsupportedPlatform)
    }
}

/// What the focused UI element is, without reading any of its content.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SelectionPreflight {
    pub pid: Option<u32>,
    pub process_name: Option<String>,
    pub window_title: Option<String>,
    /// Document URL of the web area containing the focused element, when the
    /// application exposes one. Read from AX, never AppleScript — the latter
    /// triggers an Apple Events permission prompt per target application.
    pub source_url: Option<String>,
    /// Native role/subrole used to classify editability without reading text.
    pub source_subrole: Option<String>,
    /// Conservative platform answer: false whenever writability is unknown.
    pub editable: bool,
    /// The focused control is a password field. Never read from it.
    pub secure_field: bool,
    /// Whether the platform's accessibility permission is currently granted.
    pub trusted: bool,
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
            has_a11y_tree: false,
            monitors: vec![],
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
    fn mouse_button(&self, _b: MouseButton, _t: ButtonTransition) -> Result<()> {
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

    /// A backend that can capture a monitor and report focus, so the default
    /// `screenshot_application` can actually run. Everything else is
    /// unsupported — this exists only to pin the coordinate space.
    struct FullScreenBackend {
        window: Rect,
    }

    const MONITOR_W: u32 = 3840;
    const MONITOR_H: u32 = 2160;
    const MONITOR_SCALE: f32 = 2.0;

    impl AutomationBackend for FullScreenBackend {
        fn capabilities(&self) -> Capabilities {
            Capabilities {
                platform: Platform::Windows,
                has_uia: true,
                has_input_sim: true,
                has_screenshot: true,
                has_events: true,
                has_a11y_tree: true,
                monitors: vec![MonitorInfo {
                    id: "monitor-1".into(),
                    name: "Primary".into(),
                    x: 0,
                    y: 0,
                    width: MONITOR_W,
                    height: MONITOR_H,
                    is_primary: true,
                    scale_factor: MONITOR_SCALE,
                }],
            }
        }
        fn get_focus(&self) -> Result<ElementInfo> {
            Ok(element_info(Some(42), Some(self.window)))
        }
        fn screenshot(&self, _opts: ScreenshotOpts) -> Result<Screenshot> {
            Ok(Screenshot {
                bytes: "AAA".into(),
                width: MONITOR_W,
                height: MONITOR_H,
                captured_at: 0,
                format: ImageFormat::Png,
                source_width: None,
                source_height: None,
            })
        }
        fn read_tree(&self, _r: Option<ElementRef>, _o: TreeOpts) -> Result<Vec<ElementInfo>> {
            Err(AutomationError::UnsupportedPlatform)
        }
        fn find(&self, _l: &Locator) -> Result<Option<ElementRef>> {
            Err(AutomationError::UnsupportedPlatform)
        }
        fn click(&self, _t: ClickTarget, _o: ClickOpts) -> Result<()> {
            Err(AutomationError::UnsupportedPlatform)
        }
        fn type_text(&self, _t: &str, _o: TypeOpts) -> Result<()> {
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
        fn mouse_button(&self, _b: MouseButton, _t: ButtonTransition) -> Result<()> {
            Err(AutomationError::UnsupportedPlatform)
        }
        fn cursor_position(&self) -> Result<Point> {
            Err(AutomationError::UnsupportedPlatform)
        }
        fn pick_at_point(&self, _p: Point) -> Result<ElementInfo> {
            Err(AutomationError::UnsupportedPlatform)
        }
    }

    fn element_info(process_id: Option<u32>, bounding_rect: Option<Rect>) -> ElementInfo {
        ElementInfo {
            element_ref: ElementRef("fake".into()),
            name: None,
            automation_id: None,
            control_type: None,
            class_name: None,
            bounding_rect,
            is_enabled: true,
            is_focused: true,
            process_id,
            process_name: None,
            window_title: None,
            children: None,
        }
    }

    fn app() -> ResolvedApplication {
        ResolvedApplication {
            bundle_id: None,
            path: None,
            display_name: "Fake".into(),
            process_id: 42,
        }
    }

    #[test]
    fn default_application_screenshot_describes_the_monitor_it_captured() {
        // The capture is the whole monitor, so `logical_bounds` must be the
        // monitor's logical rect. Reporting the focused *window's* rect here
        // while the pixels cover the whole screen made
        // `session::pixel_to_global_point` rescale every model coordinate
        // through the wrong rectangle — a silent, systematic click offset.
        let backend = FullScreenBackend {
            window: Rect {
                x: 100,
                y: 50,
                width: 400,
                height: 300,
            },
        };
        let capture = backend
            .screenshot_application(&app(), None, ScreenshotOpts::default())
            .expect("capture");

        assert_eq!(
            capture.logical_bounds,
            Rect {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            },
            "logical_bounds must describe the captured monitor, not the window"
        );
        assert_eq!(capture.scale_factor, f64::from(MONITOR_SCALE));
        assert_eq!(capture.display_id.as_deref(), Some("monitor-1"));
        assert_eq!(
            capture.window_id, None,
            "no per-window capture on this path"
        );
    }

    #[test]
    fn default_application_screenshot_ignores_the_window_hint() {
        // Honouring the hint is exactly what produced the mismatch: the hint
        // describes a window this path did not capture.
        let backend = FullScreenBackend {
            window: Rect {
                x: 0,
                y: 0,
                width: 10,
                height: 10,
            },
        };
        let hint = element_info(
            None,
            Some(Rect {
                x: 900,
                y: 900,
                width: 20,
                height: 20,
            }),
        );
        let capture = backend
            .screenshot_application(&app(), Some(&hint), ScreenshotOpts::default())
            .expect("capture");
        assert_eq!(capture.logical_bounds.width, 1920);
        assert_eq!(capture.logical_bounds.x, 0);
    }

    #[test]
    fn default_application_screenshot_refuses_a_background_app() {
        let backend = FullScreenBackend {
            window: Rect {
                x: 0,
                y: 0,
                width: 10,
                height: 10,
            },
        };
        let other = ResolvedApplication {
            process_id: 7,
            ..app()
        };
        assert!(backend
            .screenshot_application(&other, None, ScreenshotOpts::default())
            .is_err());
    }

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
        // A backend with no opinion must say so rather than answering
        // `Default::default()`, which would read as "nothing is focused and
        // nothing is a password field" — and silently unblock a selection read
        // the caller meant to gate.
        assert!(matches!(
            b.selection_preflight(),
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
