//! Adapter: translate Anthropic `computer_20251124` action JSON
//! (`ComputerAction`) into the canonical `automation::types::Action` the
//! unified dispatcher executes.
//!
//! This is the one Anthropic-specific edge: `ComputerAction`'s snake_case
//! wire shape (and its `left_click` / `double_click` / `triple_click` /
//! `zoom` distinctions) collapse here into the canonical `Action` variants —
//! e.g. all the click flavours become `Action::Click { target, opts }` keyed
//! by `opts.button` + `opts.count`. Pure logic, no I/O, unit-testable.

use crate::automation::types::{
    Action, ButtonTransition, ClickOpts, ClickTarget, DragOpts, ImageFormat, KeyChord, MouseButton,
    Point, Rect, Screenshot, ScreenshotOpts, ScrollOpts, ScrollTarget, TypeOpts,
};

use super::types::{ComputerAction, ComputerResult, CursorPositionPayload, ScrollDirection};

/// Each scroll "amount" from Anthropic's API maps to one wheel-notch
/// (120 wheel units). Three "down" scrolls thus produces ~3 notches.
const WHEEL_DELTA_PER_AMOUNT: i32 = 120;

/// Convert seconds (Anthropic's `duration` field, an f64) into the canonical
/// `duration_ms: u32`, clamping negatives to zero.
fn secs_to_ms(secs: f64) -> u32 {
    (secs.max(0.0) * 1000.0) as u32
}

impl From<&ComputerAction> for Action {
    fn from(action: &ComputerAction) -> Self {
        match action {
            ComputerAction::Screenshot => Action::Screenshot {
                opts: ScreenshotOpts::default(),
            },

            ComputerAction::LeftClick { coordinate } => Action::Click {
                target: ClickTarget::Point {
                    x: coordinate[0],
                    y: coordinate[1],
                },
                opts: ClickOpts {
                    button: Some(MouseButton::Left),
                    double: Some(false),
                    ..Default::default()
                },
            },

            ComputerAction::RightClick { coordinate } => Action::Click {
                target: ClickTarget::Point {
                    x: coordinate[0],
                    y: coordinate[1],
                },
                opts: ClickOpts {
                    button: Some(MouseButton::Right),
                    double: Some(false),
                    ..Default::default()
                },
            },

            ComputerAction::MiddleClick { coordinate } => Action::Click {
                target: ClickTarget::Point {
                    x: coordinate[0],
                    y: coordinate[1],
                },
                opts: ClickOpts {
                    button: Some(MouseButton::Middle),
                    double: Some(false),
                    ..Default::default()
                },
            },

            ComputerAction::DoubleClick { coordinate } => Action::Click {
                target: ClickTarget::Point {
                    x: coordinate[0],
                    y: coordinate[1],
                },
                opts: ClickOpts {
                    button: Some(MouseButton::Left),
                    double: Some(true),
                    count: Some(2),
                    ..Default::default()
                },
            },

            ComputerAction::TripleClick { coordinate } => Action::Click {
                target: ClickTarget::Point {
                    x: coordinate[0],
                    y: coordinate[1],
                },
                opts: ClickOpts {
                    button: Some(MouseButton::Left),
                    double: Some(false),
                    count: Some(3),
                    ..Default::default()
                },
            },

            ComputerAction::MouseMove { coordinate } => Action::MouseMove {
                point: Point {
                    x: coordinate[0],
                    y: coordinate[1],
                },
            },

            ComputerAction::LeftClickDrag {
                start_coordinate,
                coordinate,
            } => Action::Drag {
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
            },

            ComputerAction::LeftMouseDown => Action::MouseButton {
                button: MouseButton::Left,
                transition: ButtonTransition::Down,
            },

            ComputerAction::LeftMouseUp => Action::MouseButton {
                button: MouseButton::Left,
                transition: ButtonTransition::Up,
            },

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
                Action::Scroll {
                    target: ScrollTarget::Point {
                        x: coordinate[0],
                        y: coordinate[1],
                    },
                    opts: ScrollOpts { dx, dy },
                }
            }

            ComputerAction::Type { text } => Action::Type {
                text: text.clone(),
                opts: TypeOpts::default(),
            },

            ComputerAction::Key { text } => Action::Keys {
                chord: KeyChord(text.clone()),
            },

            ComputerAction::HoldKey { text, duration } => Action::HoldKey {
                chord: KeyChord(text.clone()),
                duration_ms: secs_to_ms(*duration),
            },

            ComputerAction::Wait { duration } => Action::Wait {
                duration_ms: secs_to_ms(*duration),
            },

            ComputerAction::Zoom { region } => Action::Screenshot {
                opts: ScreenshotOpts {
                    region: Some(Rect {
                        x: region[0],
                        y: region[1],
                        width: region[2] - region[0],
                        height: region[3] - region[1],
                    }),
                    format: Some(ImageFormat::Png),
                },
            },

            ComputerAction::CursorPosition => Action::CursorPosition,
        }
    }
}

/// Project a screenshot (or error) back into the Anthropic-shaped
/// `ComputerResult`. Used by the plugin command after the dispatcher returns
/// an `ActionOutput`.
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
            cursor: None,
        };
    }

    if let Some(sc) = screenshot {
        return ComputerResult {
            ok: true,
            output: Some(sc.bytes),
            error: None,
            display_width_px: Some(sc.width),
            display_height_px: Some(sc.height),
            cursor: None,
        };
    }

    ComputerResult {
        ok: true,
        output: None,
        error: None,
        display_width_px: None,
        display_height_px: None,
        cursor: None,
    }
}

/// Build the result for `cursor_position`.
pub fn build_cursor_position_result(point: Point) -> ComputerResult {
    ComputerResult {
        ok: true,
        output: Some(format!("{{\"x\":{},\"y\":{}}}", point.x, point.y)),
        error: None,
        display_width_px: None,
        display_height_px: None,
        cursor: Some(CursorPositionPayload {
            x: point.x,
            y: point.y,
        }),
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
        match Action::from(&action) {
            Action::Scroll { target, opts } => {
                assert!(matches!(target, ScrollTarget::Point { x: 10, y: 20 }));
                assert_eq!(opts.dx, 0);
                assert_eq!(opts.dy, 120);
            }
            _ => panic!("expected Action::Scroll"),
        }
    }

    #[test]
    fn scroll_up_three_amounts_yields_minus_360() {
        let action = ComputerAction::Scroll {
            coordinate: [0, 0],
            scroll_direction: ScrollDirection::Up,
            scroll_amount: 3,
        };
        match Action::from(&action) {
            Action::Scroll { opts, .. } => assert_eq!(opts.dy, -360),
            _ => panic!("expected Scroll"),
        }
    }

    #[test]
    fn left_mouse_down_maps_to_mouse_button() {
        assert!(matches!(
            Action::from(&ComputerAction::LeftMouseDown),
            Action::MouseButton {
                button: MouseButton::Left,
                transition: ButtonTransition::Down
            }
        ));
    }

    #[test]
    fn left_click_drag_maps_to_drag_with_left_button() {
        match Action::from(&ComputerAction::LeftClickDrag {
            start_coordinate: [5, 10],
            coordinate: [50, 100],
        }) {
            Action::Drag { from, to, opts } => {
                assert_eq!(from, Point { x: 5, y: 10 });
                assert_eq!(to, Point { x: 50, y: 100 });
                assert_eq!(opts.button, Some(MouseButton::Left));
            }
            _ => panic!("expected Drag"),
        }
    }

    #[test]
    fn double_click_sets_count_two() {
        match Action::from(&ComputerAction::DoubleClick {
            coordinate: [10, 20],
        }) {
            Action::Click { opts, .. } => {
                assert_eq!(opts.count, Some(2));
                assert_eq!(opts.double, Some(true));
            }
            _ => panic!("expected Click"),
        }
    }

    #[test]
    fn triple_click_sets_count_three() {
        match Action::from(&ComputerAction::TripleClick {
            coordinate: [30, 40],
        }) {
            Action::Click { target, opts } => {
                assert!(matches!(target, ClickTarget::Point { x: 30, y: 40 }));
                assert_eq!(opts.count, Some(3));
                assert_eq!(opts.button, Some(MouseButton::Left));
            }
            _ => panic!("expected Click"),
        }
    }

    #[test]
    fn hold_key_converts_seconds_to_millis() {
        match Action::from(&ComputerAction::HoldKey {
            text: "ctrl".into(),
            duration: 1.5,
        }) {
            Action::HoldKey { duration_ms, .. } => assert_eq!(duration_ms, 1500),
            _ => panic!("expected HoldKey"),
        }
    }

    #[test]
    fn zoom_maps_to_screenshot_with_region() {
        match Action::from(&ComputerAction::Zoom {
            region: [10, 20, 110, 220],
        }) {
            Action::Screenshot { opts } => {
                let r = opts.region.expect("region");
                assert_eq!(r.x, 10);
                assert_eq!(r.y, 20);
                assert_eq!(r.width, 100);
                assert_eq!(r.height, 200);
            }
            _ => panic!("expected Screenshot"),
        }
    }

    #[test]
    fn cursor_position_action_translates() {
        assert!(matches!(
            Action::from(&ComputerAction::CursorPosition),
            Action::CursorPosition
        ));
    }

    #[test]
    fn build_cursor_position_result_includes_cursor_field() {
        let result = build_cursor_position_result(Point { x: 42, y: 99 });
        assert!(result.ok);
        let cursor = result.cursor.expect("cursor populated");
        assert_eq!(cursor.x, 42);
        assert_eq!(cursor.y, 99);
        let output = result.output.expect("output populated");
        assert!(output.contains("\"x\":42"));
        assert!(output.contains("\"y\":99"));
    }
}
