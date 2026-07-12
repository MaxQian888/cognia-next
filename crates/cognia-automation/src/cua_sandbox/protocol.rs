//! Wire protocol for the cua `computer-server` (ADR-0020 remote-target).
//!
//! The server speaks JSON over a WebSocket at `/ws`: each message is
//! `{ "command": <string>, "params": <object> }`. Responses are JSON objects;
//! a truthy `error` field signals failure, otherwise the object carries the
//! result (`image_data` for screenshots, `size` / `position` / `success` for
//! reads). Param shapes below are verified against the cua TypeScript SDK
//! (`libs/typescript/computer/src/interface/macos.ts`).

use serde::Serialize;
use serde_json::{json, Value};

use crate::automation::types::{AutomationError, KeyChord, MouseButton, Point, Result, ScrollOpts};

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct WsRequest {
    pub command: String,
    pub params: Value,
}

impl WsRequest {
    fn new(command: &str, params: Value) -> Self {
        Self {
            command: command.to_string(),
            params,
        }
    }
}

/// Read-only command names (no params worth a builder).
pub const SCREENSHOT: &str = "screenshot";
pub const CURSOR_POSITION: &str = "get_cursor_position";
pub const ACCESSIBILITY_TREE: &str = "get_accessibility_tree";
pub const SCREEN_SIZE: &str = "get_screen_size";

fn button_str(button: MouseButton) -> &'static str {
    match button {
        MouseButton::Left => "left",
        MouseButton::Right => "right",
        MouseButton::Middle => "middle",
    }
}

/// Left / right / double click on a screen point. `Middle` and single-`Left`
/// both map to `left_click` (the server has no dedicated middle click; use
/// `mouse_button_request` for middle press/release).
pub fn click_request(point: Point, button: MouseButton, count: u32) -> WsRequest {
    let command = match (button, count) {
        (MouseButton::Left, c) if c >= 2 => "double_click",
        (MouseButton::Right, _) => "right_click",
        _ => "left_click",
    };
    WsRequest::new(command, json!({ "x": point.x, "y": point.y }))
}

pub fn type_text_request(text: &str) -> WsRequest {
    WsRequest::new("type_text", json!({ "text": text }))
}

/// A `KeyChord` is a `"ctrl+shift+t"`-style string. A single token maps to
/// `press_key`; a chord maps to `hotkey` with the token list.
pub fn keys_request(chord: &KeyChord) -> WsRequest {
    let tokens: Vec<String> = chord
        .0
        .split('+')
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect();
    if tokens.len() == 1 {
        WsRequest::new("press_key", json!({ "key": tokens[0] }))
    } else {
        WsRequest::new("hotkey", json!({ "keys": tokens }))
    }
}

/// `key_down` / `key_up` for press-and-hold (`hold_key`).
pub fn key_transition_request(key: &str, down: bool) -> WsRequest {
    WsRequest::new(
        if down { "key_down" } else { "key_up" },
        json!({ "key": key }),
    )
}

pub fn move_request(point: Point) -> WsRequest {
    WsRequest::new("move_cursor", json!({ "x": point.x, "y": point.y }))
}

/// cua `scroll` takes horizontal/vertical amounts at the current cursor.
pub fn scroll_request(opts: &ScrollOpts) -> WsRequest {
    WsRequest::new("scroll", json!({ "x": opts.dx, "y": opts.dy }))
}

/// Straight-line drag from `from` to `to`. `duration` is seconds (cua SDK
/// default 0.5s).
pub fn drag_request(from: Point, to: Point, button: MouseButton, duration_secs: f64) -> WsRequest {
    WsRequest::new(
        "drag",
        json!({
            "path": [[from.x, from.y], [to.x, to.y]],
            "button": button_str(button),
            "duration": duration_secs,
        }),
    )
}

/// Inspect a decoded server response: a truthy `error` field → `Err`.
pub fn check_response(value: Value) -> Result<Value> {
    if let Some(err) = value.get("error").and_then(|e| e.as_str()) {
        if !err.is_empty() {
            return Err(AutomationError::BackendError {
                message: err.to_string(),
            });
        }
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn double_click_maps_to_double_click() {
        let r = click_request(Point { x: 3, y: 4 }, MouseButton::Left, 2);
        assert_eq!(r.command, "double_click");
        assert_eq!(r.params["x"], 3);
        assert_eq!(r.params["y"], 4);
    }

    #[test]
    fn right_click_maps() {
        assert_eq!(
            click_request(Point { x: 1, y: 2 }, MouseButton::Right, 1).command,
            "right_click"
        );
    }

    #[test]
    fn single_left_click_maps() {
        assert_eq!(
            click_request(Point { x: 1, y: 2 }, MouseButton::Left, 1).command,
            "left_click"
        );
    }

    #[test]
    fn single_key_is_press_key() {
        let r = keys_request(&KeyChord("Enter".into()));
        assert_eq!(r.command, "press_key");
        assert_eq!(r.params["key"], "Enter");
    }

    #[test]
    fn chord_is_hotkey_with_tokens() {
        let r = keys_request(&KeyChord("ctrl+shift+t".into()));
        assert_eq!(r.command, "hotkey");
        assert_eq!(r.params["keys"], json!(["ctrl", "shift", "t"]));
    }

    #[test]
    fn scroll_maps_dx_dy_to_x_y() {
        let r = scroll_request(&ScrollOpts { dx: 5, dy: -10 });
        assert_eq!(r.params["x"], 5);
        assert_eq!(r.params["y"], -10);
    }

    #[test]
    fn drag_builds_path() {
        let r = drag_request(
            Point { x: 1, y: 2 },
            Point { x: 3, y: 4 },
            MouseButton::Left,
            0.5,
        );
        assert_eq!(r.command, "drag");
        assert_eq!(r.params["path"], json!([[1, 2], [3, 4]]));
    }

    #[test]
    fn check_response_flags_error() {
        let err = check_response(json!({ "error": "boom" }));
        assert!(err.is_err());
        let ok = check_response(json!({ "success": true }));
        assert!(ok.is_ok());
    }
}
