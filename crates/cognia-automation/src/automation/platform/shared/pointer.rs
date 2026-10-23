//! Pointer semantics shared by native backends. The OS adapter supplies the
//! move/button operations so error cleanup can be tested without desktop input.
use crate::automation::types::*;
use std::time::Duration;

/// Coordinate delivery is safe only inside the selected app's current window.
pub fn foreground_center(
    pid: u32,
    focused_pid: Option<u32>,
    same_window: bool,
    target: Rect,
    focused: Option<Rect>,
) -> Result<Point> {
    let inside = focused.is_some_and(|window| {
        target.width > 0
            && target.height > 0
            && target.x >= window.x
            && target.y >= window.y
            && i64::from(target.x) + i64::from(target.width)
                <= i64::from(window.x) + i64::from(window.width)
            && i64::from(target.y) + i64::from(target.height)
                <= i64::from(window.y) + i64::from(window.height)
    });
    if focused_pid != Some(pid) || !same_window || !inside {
        return Err(AutomationError::PermissionDenied {
            reason: "coordinate fallback requires the target app and window to be foreground"
                .into(),
        });
    }
    Ok(super::tree_shape::rect_center(&target))
}

pub fn native_click_eligible(opts: &ClickOpts) -> bool {
    opts.button.unwrap_or(MouseButton::Left) == MouseButton::Left
        && opts
            .count
            .unwrap_or(if opts.double == Some(true) { 2 } else { 1 })
            .max(1)
            == 1
        && opts.use_native.unwrap_or(true)
        && opts.modifier.is_none()
}

pub fn wheel_notches(delta: i32) -> i32 {
    if delta == 0 {
        0
    } else {
        (delta / 120).abs().max(1) * delta.signum()
    }
}

pub fn drag<A>(
    adapter: &mut A,
    from: Point,
    to: Point,
    opts: DragOpts,
    mut move_to: impl FnMut(&mut A, Point) -> Result<()>,
    mut button: impl FnMut(&mut A, MouseButton, ButtonTransition) -> Result<()>,
    mut sleep: impl FnMut(Duration),
) -> Result<()> {
    let steps = opts.steps.unwrap_or(12).max(2);
    let delay =
        Duration::from_millis(u64::from(opts.duration_ms.unwrap_or(150)) / u64::from(steps));
    let selected = opts.button.unwrap_or(MouseButton::Left);
    move_to(adapter, from)?;
    button(adapter, selected, ButtonTransition::Down)?;
    let result = (|| {
        for step in 1..=steps {
            let t = f64::from(step) / f64::from(steps);
            move_to(
                adapter,
                Point {
                    x: (f64::from(from.x) + (f64::from(to.x) - f64::from(from.x)) * t).round()
                        as i32,
                    y: (f64::from(from.y) + (f64::from(to.y) - f64::from(from.y)) * t).round()
                        as i32,
                },
            )?;
            if !delay.is_zero() {
                sleep(delay);
            }
        }
        Ok(())
    })();
    // Always release after a failed move; preserve the original error.
    let released = button(adapter, selected, ButtonTransition::Up);
    result.and(released)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn foreign_app_or_window_never_yields_an_input_point() {
        let rect = Rect {
            x: 10,
            y: 10,
            width: 40,
            height: 20,
        };
        let window = Rect {
            x: 0,
            y: 0,
            width: 100,
            height: 80,
        };
        assert!(foreground_center(1, Some(2), true, rect, Some(window)).is_err());
        assert!(foreground_center(1, Some(1), true, rect, None).is_err());
        assert!(
            foreground_center(1, Some(1), true, Rect { x: 200, ..rect }, Some(window)).is_err()
        );
        assert!(foreground_center(1, Some(1), false, rect, Some(window)).is_err());
        assert_eq!(
            foreground_center(1, Some(1), true, rect, Some(window)).unwrap(),
            Point { x: 30, y: 20 }
        );
    }

    #[test]
    fn native_press_is_only_an_unmodified_single_left_click() {
        assert!(native_click_eligible(&ClickOpts::default()));
        for opts in [
            ClickOpts {
                button: Some(MouseButton::Right),
                ..Default::default()
            },
            ClickOpts {
                count: Some(2),
                ..Default::default()
            },
            ClickOpts {
                double: Some(true),
                ..Default::default()
            },
            ClickOpts {
                use_native: Some(false),
                ..Default::default()
            },
        ] {
            assert!(!native_click_eligible(&opts));
        }
    }
    #[test]
    fn wheel_delta_smaller_than_one_notch_still_scrolls() {
        assert_eq!(
            [
                wheel_notches(0),
                wheel_notches(1),
                wheel_notches(-119),
                wheel_notches(240)
            ],
            [0, 1, -1, 2]
        );
    }
    #[test]
    fn drag_honors_button_steps_duration_and_releases_after_failure() {
        let mut events = Vec::new();
        let mut slept = Duration::ZERO;
        drag(
            &mut events,
            Point { x: -10, y: 0 },
            Point { x: 10, y: 4 },
            DragOpts {
                button: Some(MouseButton::Right),
                steps: Some(4),
                duration_ms: Some(80),
            },
            |out, point| {
                out.push(format!("move:{},{}", point.x, point.y));
                Ok(())
            },
            |out, button, state| {
                out.push(format!("{button:?}:{state:?}"));
                Ok(())
            },
            |duration| slept += duration,
        )
        .unwrap();
        assert_eq!(events.len(), 7);
        assert_eq!(events[1], "Right:Down");
        assert_eq!(events[5], "move:10,4");
        assert_eq!(events[6], "Right:Up");
        assert_eq!(slept, Duration::from_millis(80));
        events.clear();
        let result = drag(
            &mut events,
            Point { x: 0, y: 0 },
            Point { x: 8, y: 8 },
            DragOpts::default(),
            |out, _| {
                if out.is_empty() {
                    out.push("start".into());
                    Ok(())
                } else {
                    Err(AutomationError::StaleElement)
                }
            },
            |out, _, state| {
                out.push(format!("{state:?}"));
                Ok(())
            },
            |_| {},
        );
        assert!(matches!(result, Err(AutomationError::StaleElement)));
        assert_eq!(events, ["start", "Down", "Up"]);
    }
}
