//! Keyboard / mouse input via `uiautomation::inputs`. The crate wraps
//! `SendInput` under the hood, so we don't need to pair with `enigo`.

use uiautomation::inputs::{Keyboard, Mouse};
use uiautomation::types::Point;

use crate::automation::types::*;

pub fn click_point(x: i32, y: i32) -> Result<()> {
    let mouse = Mouse::new();
    mouse
        .click(&Point::new(x, y))
        .map_err(|e| AutomationError::BackendError {
            message: format!("mouse click failed: {e}"),
        })
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
