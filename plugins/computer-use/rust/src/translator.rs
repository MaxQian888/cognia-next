//! Translate Anthropic `computer_20251124` action JSON into
//! `automation::types::*` operations that the existing automation worker
//! understands.
//!
//! This module is pure logic — no I/O, no Tauri. Unit-testable without a
//! running backend.

use crate::automation::types::{
    ClickOpts, ClickTarget, ImageFormat, KeyChord, MouseButton, Rect, Screenshot,
    ScreenshotOpts, TypeOpts,
};
use super::types::*;

/// Translate a single ComputerAction into the automation types needed to
/// execute it. Returns the operation description plus any pre-execution
/// metadata (e.g. wait duration).
pub fn translate_computer_action(action: &ComputerAction) -> Result<TranslatedAction, String> {
    match action {
        ComputerAction::Screenshot => Ok(TranslatedAction::Screenshot {
            opts: ScreenshotOpts::default(),
        }),

        ComputerAction::LeftClick { coordinate } => Ok(TranslatedAction::Click {
            target: ClickTarget::Point {
                x: coordinate[0],
                y: coordinate[1],
            },
            opts: ClickOpts {
                button: Some(MouseButton::Left),
                double: Some(false),
                modifier: None,
            },
        }),

        ComputerAction::RightClick { coordinate } => Ok(TranslatedAction::Click {
            target: ClickTarget::Point {
                x: coordinate[0],
                y: coordinate[1],
            },
            opts: ClickOpts {
                button: Some(MouseButton::Right),
                double: Some(false),
                modifier: None,
            },
        }),

        ComputerAction::MiddleClick { coordinate } => Ok(TranslatedAction::Click {
            target: ClickTarget::Point {
                x: coordinate[0],
                y: coordinate[1],
            },
            opts: ClickOpts {
                button: Some(MouseButton::Middle),
                double: Some(false),
                modifier: None,
            },
        }),

        ComputerAction::DoubleClick { coordinate } => Ok(TranslatedAction::Click {
            target: ClickTarget::Point {
                x: coordinate[0],
                y: coordinate[1],
            },
            opts: ClickOpts {
                button: Some(MouseButton::Left),
                double: Some(true),
                modifier: None,
            },
        }),

        ComputerAction::TripleClick { coordinate } => Ok(TranslatedAction::Click {
            target: ClickTarget::Point {
                x: coordinate[0],
                y: coordinate[1],
            },
            opts: ClickOpts {
                button: Some(MouseButton::Left),
                double: Some(false),
                modifier: None,
            },
        }),

        ComputerAction::MouseMove { coordinate } => Ok(TranslatedAction::MouseMove {
            x: coordinate[0],
            y: coordinate[1],
        }),

        ComputerAction::LeftClickDrag {
            start_coordinate,
            coordinate,
        } => Ok(TranslatedAction::Drag {
            start: Coordinate {
                x: start_coordinate[0],
                y: start_coordinate[1],
            },
            end: Coordinate {
                x: coordinate[0],
                y: coordinate[1],
            },
        }),

        ComputerAction::LeftMouseDown => Ok(TranslatedAction::MouseButtonDown {
            button: MouseButton::Left,
        }),

        ComputerAction::LeftMouseUp => Ok(TranslatedAction::MouseButtonUp {
            button: MouseButton::Left,
        }),

        ComputerAction::Scroll {
            coordinate,
            scroll_direction,
            scroll_amount,
        } => Ok(TranslatedAction::Scroll {
            coordinate: Coordinate {
                x: coordinate[0],
                y: coordinate[1],
            },
            direction: *scroll_direction,
            amount: *scroll_amount,
        }),

        ComputerAction::Type { text } => Ok(TranslatedAction::TypeText {
            text: text.clone(),
            opts: TypeOpts::default(),
        }),

        ComputerAction::Key { text } => Ok(TranslatedAction::SendKeys {
            chord: KeyChord(text.clone()),
        }),

        ComputerAction::HoldKey { text, duration } => Ok(TranslatedAction::HoldKey {
            chord: KeyChord(text.clone()),
            duration_secs: *duration,
        }),

        ComputerAction::Wait { duration } => Ok(TranslatedAction::Wait {
            duration_secs: *duration,
        }),

        ComputerAction::Zoom { region } => Ok(TranslatedAction::Screenshot {
            opts: ScreenshotOpts {
                region: Some(Rect {
                    x: region[0],
                    y: region[1],
                    width: region[2] - region[0],
                    height: region[3] - region[1],
                }),
                format: Some(ImageFormat::Png),
            },
        }),
    }
}

/// Simple 2D coordinate — local to this module (not in automation::types).
#[derive(Debug, Clone, Copy)]
pub struct Coordinate {
    pub x: i32,
    pub y: i32,
}

/// An intermediate representation of what the automation worker should do.
/// Some variants map 1:1 to AutomationHandle methods; others require
/// extending the backend trait (MouseMove, Drag, Scroll, MouseButtonDown/Up,
/// HoldKey, Wait).
#[derive(Debug, Clone)]
pub enum TranslatedAction {
    Screenshot { opts: ScreenshotOpts },
    Click { target: ClickTarget, opts: ClickOpts },
    MouseMove { x: i32, y: i32 },
    Drag { start: Coordinate, end: Coordinate },
    MouseButtonDown { button: MouseButton },
    MouseButtonUp { button: MouseButton },
    Scroll {
        coordinate: Coordinate,
        direction: ScrollDirection,
        amount: i32,
    },
    TypeText { text: String, opts: TypeOpts },
    SendKeys { chord: KeyChord },
    HoldKey { chord: KeyChord, duration_secs: f64 },
    Wait { duration_secs: f64 },
}

/// Turn the backend result into the Anthropic-shaped JSON result.
pub fn build_computer_result(
    screenshot: Option<Screenshot>,
    maybe_error: Option<String>,
) -> ComputerResult {
    if let Some(err) = maybe_error {
        return ComputerResult {
            ok: false,
            output: None,
            error: Some(err),
            display_width_px: None,
            display_height_px: None,
        };
    }

    if let Some(sc) = screenshot {
        return ComputerResult {
            ok: true,
            output: Some(sc.bytes),
            error: None,
            display_width_px: Some(sc.width),
            display_height_px: Some(sc.height),
        };
    }

    ComputerResult {
        ok: true,
        output: None,
        error: None,
        display_width_px: None,
        display_height_px: None,
    }
}
