//! Translate Anthropic `computer_20251124` action JSON into
//! `automation::types::*` operations that the existing automation worker
//! understands.
//!
//! This module is pure logic — no I/O, no Tauri. Unit-testable without a
//! running backend.

use crate::automation::types::{
    ButtonTransition, ClickOpts, ClickTarget, DragOpts, ImageFormat, KeyChord, MouseButton, Point,
    Rect, Screenshot, ScreenshotOpts, ScrollOpts, ScrollTarget, TypeOpts,
};
use super::types::*;

/// Each scroll "amount" from Anthropic's API maps to one wheel-notch
/// (120 wheel units). Three "down" scrolls thus produces ~3 notches.
const WHEEL_DELTA_PER_AMOUNT: i32 = 120;

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
                ..Default::default()
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
                ..Default::default()
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
                ..Default::default()
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
                ..Default::default()
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
                ..Default::default()
            },
        }),

        ComputerAction::MouseMove { coordinate } => Ok(TranslatedAction::MouseMove {
            point: Point {
                x: coordinate[0],
                y: coordinate[1],
            },
        }),

        ComputerAction::LeftClickDrag {
            start_coordinate,
            coordinate,
        } => Ok(TranslatedAction::Drag {
            from: Point {
                x: start_coordinate[0],
                y: start_coordinate[1],
            },
            to: Point {
                x: coordinate[0],
                y: coordinate[1],
            },
            opts: DragOpts {
                button: Some(MouseButton::Left),
                ..Default::default()
            },
        }),

        ComputerAction::LeftMouseDown => Ok(TranslatedAction::MouseButton {
            button: MouseButton::Left,
            transition: ButtonTransition::Down,
        }),

        ComputerAction::LeftMouseUp => Ok(TranslatedAction::MouseButton {
            button: MouseButton::Left,
            transition: ButtonTransition::Up,
        }),

        ComputerAction::Scroll {
            coordinate,
            scroll_direction,
            scroll_amount,
        } => {
            let units = *scroll_amount * WHEEL_DELTA_PER_AMOUNT;
            let (dx, dy) = match scroll_direction {
                ScrollDirection::Up => (0, -units),
                ScrollDirection::Down => (0, units),
                ScrollDirection::Left => (-units, 0),
                ScrollDirection::Right => (units, 0),
            };
            Ok(TranslatedAction::Scroll {
                target: ScrollTarget::Point {
                    x: coordinate[0],
                    y: coordinate[1],
                },
                opts: ScrollOpts { dx, dy },
            })
        }

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

/// An intermediate representation of what the automation worker should do.
/// Variants map 1:1 to `AutomationHandle` methods on the worker.
#[derive(Debug, Clone)]
pub enum TranslatedAction {
    Screenshot { opts: ScreenshotOpts },
    Click { target: ClickTarget, opts: ClickOpts },
    MouseMove { point: Point },
    Drag { from: Point, to: Point, opts: DragOpts },
    MouseButton { button: MouseButton, transition: ButtonTransition },
    Scroll { target: ScrollTarget, opts: ScrollOpts },
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scroll_down_one_amount_yields_120_wheel_units() {
        let action = ComputerAction::Scroll {
            coordinate: [10, 20],
            scroll_direction: ScrollDirection::Down,
            scroll_amount: 1,
        };
        let translated = translate_computer_action(&action).unwrap();
        match translated {
            TranslatedAction::Scroll { target, opts } => {
                match target {
                    ScrollTarget::Point { x, y } => {
                        assert_eq!(x, 10);
                        assert_eq!(y, 20);
                    }
                    _ => panic!("expected ScrollTarget::Point"),
                }
                assert_eq!(opts.dx, 0);
                assert_eq!(opts.dy, 120);
            }
            _ => panic!("expected TranslatedAction::Scroll"),
        }
    }

    #[test]
    fn scroll_up_three_amounts_yields_minus_360() {
        let action = ComputerAction::Scroll {
            coordinate: [0, 0],
            scroll_direction: ScrollDirection::Up,
            scroll_amount: 3,
        };
        let translated = translate_computer_action(&action).unwrap();
        match translated {
            TranslatedAction::Scroll { opts, .. } => assert_eq!(opts.dy, -360),
            _ => panic!("expected Scroll"),
        }
    }

    #[test]
    fn left_mouse_down_maps_to_mouse_button() {
        let translated = translate_computer_action(&ComputerAction::LeftMouseDown).unwrap();
        assert!(matches!(
            translated,
            TranslatedAction::MouseButton {
                button: MouseButton::Left,
                transition: ButtonTransition::Down
            }
        ));
    }

    #[test]
    fn left_click_drag_maps_to_drag_with_left_button() {
        let translated = translate_computer_action(&ComputerAction::LeftClickDrag {
            start_coordinate: [5, 10],
            coordinate: [50, 100],
        })
        .unwrap();
        match translated {
            TranslatedAction::Drag { from, to, opts } => {
                assert_eq!(from.x, 5);
                assert_eq!(from.y, 10);
                assert_eq!(to.x, 50);
                assert_eq!(to.y, 100);
                assert_eq!(opts.button, Some(MouseButton::Left));
            }
            _ => panic!("expected Drag"),
        }
    }
}
