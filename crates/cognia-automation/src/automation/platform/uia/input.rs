//! Keyboard / mouse input via `uiautomation::inputs`. The crate wraps
//! `SendInput` under the hood, so we don't need to pair with `enigo`.
//!
//! Functions deliberately return `crate::automation::types::Result<T>` so
//! callers can `?` through them without an extra error-map step. The
//! `uiautomation` crate's own error type is surfaced as
//! `AutomationError::BackendError`.

use std::thread;
use std::time::Duration;

use uiautomation::inputs::{Keyboard, Mouse};
use uiautomation::types::Point as UiaPoint;
use windows::Win32::Foundation::POINT;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetDoubleClickTime, SendInput, INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_ABSOLUTE,
    MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN,
    MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP,
    MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL, MOUSEINPUT, MOUSE_EVENT_FLAGS,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
    SM_YVIRTUALSCREEN,
};

use crate::automation::types::*;

pub fn click_point(x: i32, y: i32) -> Result<()> {
    let mouse = Mouse::new();
    mouse
        .click(&UiaPoint::new(x, y))
        .map_err(|e| AutomationError::BackendError {
            message: format!("mouse click failed: {e}"),
        })
}

/// Click at `(x, y)` `count` times in a row. Consecutive clicks are spaced
/// to fall within `GetDoubleClickTime` so the OS recognises the sequence as
/// a real double / triple click instead of independent single clicks. A
/// `count` of 0 or 1 is treated as a single click.
pub fn click_point_multi(x: i32, y: i32, count: u32) -> Result<()> {
    let n = count.max(1);
    if n == 1 {
        return click_point(x, y);
    }
    // GetDoubleClickTime is the *maximum* gap that still registers as a
    // multi-click. Use half of it so we stay comfortably under the threshold
    // even when the system call returns a generous value.
    let dct = unsafe { GetDoubleClickTime() };
    let gap_ms = u64::from(dct).max(1) / 2;
    let gap = Duration::from_millis(gap_ms);
    for i in 0..n {
        click_point(x, y)?;
        if i + 1 < n {
            thread::sleep(gap);
        }
    }
    Ok(())
}

/// Read the current cursor position via `GetCursorPos`. Read-only — no
/// gating side effects.
pub fn cursor_position() -> Result<Point> {
    let mut p = POINT { x: 0, y: 0 };
    unsafe {
        GetCursorPos(&mut p).map_err(|e| AutomationError::BackendError {
            message: format!("GetCursorPos failed: {e}"),
        })?;
    }
    Ok(Point { x: p.x, y: p.y })
}

pub fn type_text(text: &str, delay_ms: Option<u32>) -> Result<()> {
    let mut kb = Keyboard::new();
    if let Some(ms) = delay_ms {
        kb = kb.interval(u64::from(ms));
    }
    kb.send_text(text)
        .map_err(|e| AutomationError::BackendError {
            message: format!("keyboard send_text failed: {e}"),
        })
}

pub fn send_chord(chord: &KeyChord) -> Result<()> {
    let kb = Keyboard::new();
    kb.send_keys(&chord.0)
        .map_err(|e| AutomationError::BackendError {
            message: format!("keyboard send_keys failed: {e}"),
        })
}

// ─────────────────────────────────────────────────────────────────────────────
// New M5 primitives. The `uiautomation` crate's `Mouse` API doesn't expose
// raw button-down / button-up or scroll wheel — those go through `SendInput`
// directly. We keep `Mouse::click` for the simple case to preserve existing
// behavior bit-for-bit.
// ─────────────────────────────────────────────────────────────────────────────

pub fn move_to(x: i32, y: i32) -> Result<()> {
    let (mx, my) = to_absolute_coords(x, y);
    let input = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: mx,
                dy: my,
                mouseData: 0,
                dwFlags: MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    send_input_one(input)
}

pub fn button(button: MouseButton, transition: ButtonTransition) -> Result<()> {
    let flag = match (button, transition) {
        (MouseButton::Left, ButtonTransition::Down) => MOUSEEVENTF_LEFTDOWN,
        (MouseButton::Left, ButtonTransition::Up) => MOUSEEVENTF_LEFTUP,
        (MouseButton::Right, ButtonTransition::Down) => MOUSEEVENTF_RIGHTDOWN,
        (MouseButton::Right, ButtonTransition::Up) => MOUSEEVENTF_RIGHTUP,
        (MouseButton::Middle, ButtonTransition::Down) => MOUSEEVENTF_MIDDLEDOWN,
        (MouseButton::Middle, ButtonTransition::Up) => MOUSEEVENTF_MIDDLEUP,
    };
    let input = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: 0,
                dy: 0,
                mouseData: 0,
                dwFlags: flag,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    send_input_one(input)
}

pub fn drag(from: Point, to: Point, opts: DragOpts) -> Result<()> {
    let button = opts.button.unwrap_or(MouseButton::Left);
    let steps = opts.steps.unwrap_or(12).max(2);
    let duration_ms = opts.duration_ms.unwrap_or(150);
    let step_delay = Duration::from_millis(u64::from(duration_ms) / u64::from(steps));

    move_to(from.x, from.y)?;
    self::button(button, ButtonTransition::Down)?;

    for i in 1..=steps {
        let t = f64::from(i) / f64::from(steps);
        let x = from.x as f64 + (to.x - from.x) as f64 * t;
        let y = from.y as f64 + (to.y - from.y) as f64 * t;
        move_to(x as i32, y as i32)?;
        if step_delay > Duration::from_millis(0) {
            thread::sleep(step_delay);
        }
    }

    self::button(button, ButtonTransition::Up)
}

pub fn scroll_at(point: Point, opts: ScrollOpts) -> Result<()> {
    move_to(point.x, point.y)?;
    if opts.dy != 0 {
        send_wheel(opts.dy, false)?;
    }
    if opts.dx != 0 {
        send_wheel(opts.dx, true)?;
    }
    Ok(())
}

pub fn hold_key(chord: &KeyChord, duration_ms: u32) -> Result<()> {
    // `uiautomation::inputs::Keyboard::begin_hold_keys` requires `&mut self`,
    // which is why we bind `kb` as mutable here. The crate parses the same
    // chord syntax `send_keys` accepts ("{Shift}", "{Ctrl}{Alt}", etc.).
    let mut kb = Keyboard::new();
    kb.begin_hold_keys(&chord.0)
        .map_err(|e| AutomationError::BackendError {
            message: format!("begin_hold_keys failed: {e}"),
        })?;
    if duration_ms > 0 {
        thread::sleep(Duration::from_millis(u64::from(duration_ms)));
    }
    kb.end_hold_keys()
        .map_err(|e| AutomationError::BackendError {
            message: format!("end_hold_keys failed: {e}"),
        })?;
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers.
// ─────────────────────────────────────────────────────────────────────────────

fn send_wheel(delta: i32, horizontal: bool) -> Result<()> {
    let flag: MOUSE_EVENT_FLAGS = if horizontal {
        MOUSEEVENTF_HWHEEL
    } else {
        MOUSEEVENTF_WHEEL
    };
    let input = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: 0,
                dy: 0,
                // Wheel mouseData is in WHEEL_DELTA units (120 per notch),
                // cast through u32 to preserve the sign bit pattern.
                mouseData: delta as u32,
                dwFlags: flag,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    send_input_one(input)
}

fn send_input_one(input: INPUT) -> Result<()> {
    let inputs = [input];
    let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent == 0 {
        let err = unsafe { windows::Win32::Foundation::GetLastError() };
        return Err(AutomationError::BackendError {
            message: format!("SendInput failed: {err:?}"),
        });
    }
    Ok(())
}

/// Convert pixel (x, y) into the 0..65535 normalized coordinates that
/// `MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK` expects.
fn to_absolute_coords(x: i32, y: i32) -> (i32, i32) {
    let origin_x = unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) };
    let origin_y = unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) };
    let width = unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) };
    let height = unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) };
    to_absolute_coords_in_rect(x, y, origin_x, origin_y, width, height)
}

fn to_absolute_coords_in_rect(
    x: i32,
    y: i32,
    origin_x: i32,
    origin_y: i32,
    width: i32,
    height: i32,
) -> (i32, i32) {
    let max_x = i64::from(width.saturating_sub(1).max(0));
    let max_y = i64::from(height.saturating_sub(1).max(0));
    let denom_x = max_x.max(1);
    let denom_y = max_y.max(1);
    let rel_x = i64::from(x)
        .saturating_sub(i64::from(origin_x))
        .clamp(0, max_x);
    let rel_y = i64::from(y)
        .saturating_sub(i64::from(origin_y))
        .clamp(0, max_y);
    let nx = rel_x * 65535 / denom_x;
    let ny = rel_y * 65535 / denom_y;
    (nx as i32, ny as i32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_absolute_coords_in_rect_origin_is_zero() {
        let (nx, ny) = to_absolute_coords_in_rect(0, 0, 0, 0, 1920, 1080);
        assert_eq!(nx, 0);
        assert_eq!(ny, 0);
    }

    #[test]
    fn to_absolute_coords_in_rect_handles_negative_virtual_origin() {
        let (nx, ny) = to_absolute_coords_in_rect(-1920, 0, -1920, 0, 3840, 1080);
        assert_eq!(nx, 0);
        assert_eq!(ny, 0);

        let (right, bottom) = to_absolute_coords_in_rect(1919, 1079, -1920, 0, 3840, 1080);
        assert_eq!(right, 65535);
        assert_eq!(bottom, 65535);
    }

    #[test]
    fn to_absolute_coords_in_rect_clamps_outside_desktop() {
        let (nx, ny) = to_absolute_coords_in_rect(-20, 1200, 0, 0, 1920, 1080);
        assert_eq!(nx, 0);
        assert_eq!(ny, 65535);
    }
}
