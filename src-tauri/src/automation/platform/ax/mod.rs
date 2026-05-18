//! macOS AXAPI back-end — minimum viable.
//!
//! Implements the four cross-platform primitives that Anthropic's
//! `computer_20251124` action set needs even on systems without a UIA tree:
//!
//!   - `capabilities` — reports `hasInputSim: true`, `hasScreenshot: true`,
//!     `hasUia: false` (AXUIElement-based tree navigation lands later).
//!   - `screenshot` — delegates to the shared xcap-based capture.
//!   - `click` (Point only — Element targets fall through `UnsupportedPlatform`).
//!   - `type_text` / `send_keys` — `enigo`-based synthesis.
//!
//! The remaining trait methods stay `UnsupportedPlatform`. Once a real
//! AXUIElement-backed tree walker lands, the gate can flip to `hasUia: true`
//! and Element-target clicks / window ops / pattern dispatch follow.

use enigo::{Direction, Enigo, Keyboard, Mouse, Settings};

use crate::automation::backend::AutomationBackend;
use crate::automation::platform::shared::screenshot;
use crate::automation::types::*;

pub struct AxBackend;

impl AxBackend {
    pub fn new() -> std::result::Result<Self, String> {
        Ok(Self)
    }
}

impl AutomationBackend for AxBackend {
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            platform: Platform::Macos,
            has_uia: false,
            has_input_sim: true,
            has_screenshot: true,
            has_events: false,
        }
    }

    fn get_focus(&self) -> Result<ElementInfo> {
        Err(AutomationError::UnsupportedPlatform)
    }

    fn read_tree(&self, _root: Option<ElementRef>, _opts: TreeOpts) -> Result<Vec<ElementInfo>> {
        Err(AutomationError::UnsupportedPlatform)
    }

    fn find(&self, _locator: &Locator) -> Result<Option<ElementRef>> {
        Err(AutomationError::UnsupportedPlatform)
    }

    fn screenshot(&self, opts: ScreenshotOpts) -> Result<Screenshot> {
        screenshot::capture_primary(&opts)
    }

    fn click(&self, target: ClickTarget, opts: ClickOpts) -> Result<()> {
        match target {
            ClickTarget::Element { .. } => Err(AutomationError::UnsupportedPlatform),
            ClickTarget::Point { x, y } => {
                let mut e = enigo_new()?;
                e.move_mouse(x, y, enigo::Coordinate::Abs)
                    .map_err(input_err("mouse move"))?;
                let button = to_enigo_button(opts.button);
                if opts.double.unwrap_or(false) {
                    e.button(button, Direction::Click).map_err(input_err("click"))?;
                    e.button(button, Direction::Click).map_err(input_err("click"))?;
                } else {
                    e.button(button, Direction::Click).map_err(input_err("click"))?;
                }
                Ok(())
            }
        }
    }

    fn type_text(&self, text: &str, _opts: TypeOpts) -> Result<()> {
        let mut e = enigo_new()?;
        e.text(text).map_err(input_err("type_text"))
    }

    fn send_keys(&self, chord: &KeyChord) -> Result<()> {
        let mut e = enigo_new()?;
        // enigo's text-style chord input ("a", "b") doesn't cover modifier
        // chords. For the minimum-viable AX backend we accept simple single
        // tokens like "Enter", "Tab", "Escape" — anything more elaborate
        // (Ctrl+Shift+T) needs the same parser the UIA backend uses; that's
        // not in scope for the minimum-viable surface.
        let key = match chord.0.to_lowercase().as_str() {
            "enter" | "return" => enigo::Key::Return,
            "tab" => enigo::Key::Tab,
            "escape" | "esc" => enigo::Key::Escape,
            "backspace" => enigo::Key::Backspace,
            "delete" | "del" => enigo::Key::Delete,
            "space" => enigo::Key::Space,
            other => {
                return Err(AutomationError::BackendError {
                    message: format!(
                        "macOS minimum-viable backend supports single-token chords \
                         (Enter / Tab / Escape / Backspace / Delete / Space). \
                         Got: '{other}'."
                    ),
                });
            }
        };
        e.key(key, Direction::Click).map_err(input_err("send_keys"))
    }

    fn invoke_pattern(
        &self,
        _t: ElementRef,
        _p: PatternKind,
        _a: serde_json::Value,
    ) -> Result<serde_json::Value> {
        Err(AutomationError::UnsupportedPlatform)
    }

    fn window_op(&self, _t: ElementRef, _op: WindowOp) -> Result<()> {
        Err(AutomationError::UnsupportedPlatform)
    }

    fn subscribe_events(&self, _f: EventFilter) -> Result<SubscriptionId> {
        Err(AutomationError::UnsupportedPlatform)
    }

    fn unsubscribe(&self, _s: SubscriptionId) -> Result<()> {
        Err(AutomationError::UnsupportedPlatform)
    }

    fn mouse_move(&self, point: Point) -> Result<()> {
        let mut e = enigo_new()?;
        e.move_mouse(point.x, point.y, enigo::Coordinate::Abs)
            .map_err(input_err("mouse_move"))
    }

    fn drag(&self, from: Point, to: Point, _opts: DragOpts) -> Result<()> {
        let mut e = enigo_new()?;
        e.move_mouse(from.x, from.y, enigo::Coordinate::Abs)
            .map_err(input_err("drag.move_start"))?;
        e.button(enigo::Button::Left, Direction::Press)
            .map_err(input_err("drag.press"))?;
        e.move_mouse(to.x, to.y, enigo::Coordinate::Abs)
            .map_err(input_err("drag.move_end"))?;
        e.button(enigo::Button::Left, Direction::Release)
            .map_err(input_err("drag.release"))
    }

    fn scroll(&self, target: ScrollTarget, opts: ScrollOpts) -> Result<()> {
        let mut e = enigo_new()?;
        if let ScrollTarget::Point { x, y } = target {
            e.move_mouse(x, y, enigo::Coordinate::Abs)
                .map_err(input_err("scroll.move"))?;
        }
        // enigo's `scroll(amount, axis)` uses notch-sized increments (positive
        // = forward / down). Our wire format is wheel units (120 per notch).
        let notches_y = opts.dy / 120;
        let notches_x = opts.dx / 120;
        if notches_y != 0 {
            e.scroll(notches_y, enigo::Axis::Vertical)
                .map_err(input_err("scroll.vertical"))?;
        }
        if notches_x != 0 {
            e.scroll(notches_x, enigo::Axis::Horizontal)
                .map_err(input_err("scroll.horizontal"))?;
        }
        Ok(())
    }

    fn hold_key(&self, chord: &KeyChord, duration_ms: u32) -> Result<()> {
        let _ = chord;
        let _ = duration_ms;
        Err(AutomationError::BackendError {
            message: "hold_key on macOS requires a full keyboard parser — not in the \
                      minimum-viable surface"
                .into(),
        })
    }

    fn mouse_button(
        &self,
        button: MouseButton,
        transition: ButtonTransition,
    ) -> Result<()> {
        let mut e = enigo_new()?;
        let b = to_enigo_button(Some(button));
        let dir = match transition {
            ButtonTransition::Down => Direction::Press,
            ButtonTransition::Up => Direction::Release,
        };
        e.button(b, dir).map_err(input_err("mouse_button"))
    }

    fn cursor_position(&self) -> Result<Point> {
        let e = enigo_new()?;
        let (x, y) = e.location().map_err(input_err("cursor_position"))?;
        Ok(Point { x, y })
    }
}

fn enigo_new() -> Result<Enigo> {
    Enigo::new(&Settings::default()).map_err(|e| AutomationError::BackendError {
        message: format!("enigo init failed: {e}"),
    })
}

fn to_enigo_button(b: Option<MouseButton>) -> enigo::Button {
    match b.unwrap_or(MouseButton::Left) {
        MouseButton::Left => enigo::Button::Left,
        MouseButton::Right => enigo::Button::Right,
        MouseButton::Middle => enigo::Button::Middle,
    }
}

fn input_err(label: &'static str) -> impl Fn(enigo::InputError) -> AutomationError {
    move |e| AutomationError::BackendError {
        message: format!("{label}: {e}"),
    }
}
