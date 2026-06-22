//! UIA pattern dispatch — translates the cross-platform `PatternKind` /
//! `WindowOp` enums into the matching `uiautomation::patterns::*` calls.
//!
//! Two entry points:
//!
//! - `try_pattern_click(elt)` — attempt-only helper used by the
//!   Pattern-first click strategy. Tries `Invoke` → `Toggle` →
//!   `SelectionItem`. Returns `Ok(true)` on first success, `Ok(false)` when
//!   none of those patterns are supported (caller should fall back to a
//!   coordinate click), `Err` only for real backend faults.
//! - `dispatch_pattern(elt, kind, args)` — the implementation of
//!   `AutomationBackend::invoke_pattern`. Each pattern's `args` payload is
//!   documented inline so the TS-side `desktop.invokePattern` calls have a
//!   stable contract.
//! - `dispatch_window_op(elt, op)` — `AutomationBackend::window_op` body.
//!   Uses `UIWindowPattern` for visual-state transitions and
//!   `UITransformPattern` for resize; falls through to `set_focus` /
//!   `Close()` for the operations UIWindowPattern doesn't expose.

use serde_json::{json, Value};
use uiautomation::patterns::{
    UIExpandCollapsePattern, UIInvokePattern, UIRangeValuePattern, UIScrollItemPattern,
    UISelectionItemPattern, UITogglePattern, UITransformPattern, UIValuePattern, UIWindowPattern,
};
use uiautomation::types::{ScrollAmount, WindowVisualState};
use uiautomation::UIElement as UiaElement;

use crate::automation::types::*;

/// Try Invoke → Toggle → SelectionItem patterns in order. Returns
/// `Ok(true)` if a pattern fired successfully, `Ok(false)` if none of the
/// three patterns are supported on this element (caller should fall back to
/// a coordinate click), `Err(_)` only for a real backend fault from a
/// pattern we DID get.
pub fn try_pattern_click(elt: &UiaElement) -> Result<bool> {
    if let Ok(p) = elt.get_pattern::<UIInvokePattern>() {
        p.invoke().map_err(|e| AutomationError::BackendError {
            message: format!("InvokePattern.invoke: {e}"),
        })?;
        return Ok(true);
    }
    if let Ok(p) = elt.get_pattern::<UITogglePattern>() {
        p.toggle().map_err(|e| AutomationError::BackendError {
            message: format!("TogglePattern.toggle: {e}"),
        })?;
        return Ok(true);
    }
    if let Ok(p) = elt.get_pattern::<UISelectionItemPattern>() {
        p.select().map_err(|e| AutomationError::BackendError {
            message: format!("SelectionItemPattern.select: {e}"),
        })?;
        return Ok(true);
    }
    Ok(false)
}

pub fn dispatch_pattern(elt: &UiaElement, pattern: PatternKind, args: Value) -> Result<Value> {
    match pattern {
        PatternKind::Invoke => {
            let p = elt
                .get_pattern::<UIInvokePattern>()
                .map_err(|e| pattern_unavailable("Invoke", e))?;
            p.invoke().map_err(|e| backend("InvokePattern.invoke", e))?;
            Ok(json!({ "ok": true }))
        }
        PatternKind::Toggle => {
            let p = elt
                .get_pattern::<UITogglePattern>()
                .map_err(|e| pattern_unavailable("Toggle", e))?;
            p.toggle().map_err(|e| backend("TogglePattern.toggle", e))?;
            Ok(json!({ "ok": true }))
        }
        PatternKind::SelectionItem => {
            let p = elt
                .get_pattern::<UISelectionItemPattern>()
                .map_err(|e| pattern_unavailable("SelectionItem", e))?;
            p.select()
                .map_err(|e| backend("SelectionItemPattern.select", e))?;
            Ok(json!({ "ok": true }))
        }
        PatternKind::Value => {
            let value = args.get("value").and_then(|v| v.as_str()).ok_or(
                AutomationError::BackendError {
                    message: "Value pattern requires args.value: string".into(),
                },
            )?;
            let p = elt
                .get_pattern::<UIValuePattern>()
                .map_err(|e| pattern_unavailable("Value", e))?;
            p.set_value(value)
                .map_err(|e| backend("ValuePattern.set_value", e))?;
            Ok(json!({ "ok": true }))
        }
        PatternKind::RangeValue => {
            let value = args.get("value").and_then(|v| v.as_f64()).ok_or(
                AutomationError::BackendError {
                    message: "RangeValue pattern requires args.value: number".into(),
                },
            )?;
            let p = elt
                .get_pattern::<UIRangeValuePattern>()
                .map_err(|e| pattern_unavailable("RangeValue", e))?;
            p.set_value(value)
                .map_err(|e| backend("RangeValuePattern.set_value", e))?;
            Ok(json!({ "ok": true }))
        }
        PatternKind::ExpandCollapse => {
            let op = args.get("op").and_then(|v| v.as_str()).unwrap_or("expand");
            let p = elt
                .get_pattern::<UIExpandCollapsePattern>()
                .map_err(|e| pattern_unavailable("ExpandCollapse", e))?;
            match op {
                "expand" => p.expand().map_err(|e| backend("expand", e))?,
                "collapse" => p.collapse().map_err(|e| backend("collapse", e))?,
                other => {
                    return Err(AutomationError::BackendError {
                        message: format!("ExpandCollapse: unknown op '{other}'"),
                    })
                }
            }
            Ok(json!({ "ok": true }))
        }
        PatternKind::ScrollItem => {
            let p = elt
                .get_pattern::<UIScrollItemPattern>()
                .map_err(|e| pattern_unavailable("ScrollItem", e))?;
            p.scroll_into_view()
                .map_err(|e| backend("ScrollItem.scroll_into_view", e))?;
            Ok(json!({ "ok": true }))
        }
        PatternKind::Window => {
            // Window pattern args: { op: "focus" | "close" | "minimize" |
            // "maximize" | "restore" }
            let op =
                args.get("op")
                    .and_then(|v| v.as_str())
                    .ok_or(AutomationError::BackendError {
                        message: "Window pattern requires args.op".into(),
                    })?;
            dispatch_window_op(elt, parse_window_op(op)?)?;
            Ok(json!({ "ok": true }))
        }
        PatternKind::Transform => {
            // Transform args: { op: "move", x, y } or { op: "resize", width,
            // height } or { op: "rotate", degrees }
            let op = args.get("op").and_then(|v| v.as_str()).unwrap_or("move");
            let p = elt
                .get_pattern::<UITransformPattern>()
                .map_err(|e| pattern_unavailable("Transform", e))?;
            match op {
                "move" => {
                    let x = args.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
                    let y = args.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);
                    p.move_to(x, y)
                        .map_err(|e| backend("Transform.move_to", e))?;
                }
                "resize" => {
                    let (width, height) = if let Some(rect) = args.get("rect") {
                        // Also accept the {rect: {width, height}} shape that
                        // the workflow executor used to send via the
                        // invokePattern("transform", {op:"resize", rect})
                        // hack — keeps backward compat.
                        let w = rect.get("width").and_then(|v| v.as_f64()).unwrap_or(0.0);
                        let h = rect.get("height").and_then(|v| v.as_f64()).unwrap_or(0.0);
                        (w, h)
                    } else {
                        let w = args.get("width").and_then(|v| v.as_f64()).unwrap_or(0.0);
                        let h = args.get("height").and_then(|v| v.as_f64()).unwrap_or(0.0);
                        (w, h)
                    };
                    p.resize(width, height)
                        .map_err(|e| backend("Transform.resize", e))?;
                }
                "rotate" => {
                    let degrees = args.get("degrees").and_then(|v| v.as_f64()).unwrap_or(0.0);
                    p.rotate(degrees)
                        .map_err(|e| backend("Transform.rotate", e))?;
                }
                other => {
                    return Err(AutomationError::BackendError {
                        message: format!("Transform: unknown op '{other}'"),
                    })
                }
            }
            Ok(json!({ "ok": true }))
        }
        PatternKind::Text => {
            // Text pattern is read-only in the cross-platform contract; we
            // surface document-range selection / extraction through dedicated
            // `desktop_read_tree` paths, not here. Return a clean "not
            // supported via dispatch" so the renderer gets a stable code.
            Err(AutomationError::BackendError {
                message: "Text pattern dispatch is not yet exposed — use desktop_read_tree".into(),
            })
        }
    }
}

pub fn dispatch_window_op(elt: &UiaElement, op: WindowOp) -> Result<()> {
    match op {
        WindowOp::Focus => elt.set_focus().map_err(|e| backend("set_focus", e)),
        WindowOp::Close => {
            // UIWindowPattern doesn't expose Close on its own — many
            // implementations honor SendKeys "{Alt}{F4}" after focus, but the
            // canonical way is the WindowPattern's IUIAutomationWindowPattern.Close.
            // The crate exposes `close()` via WindowPattern in newer releases;
            // here we emulate by focus + Alt+F4 chord through the keyboard
            // helper to stay framework-internal. We avoid touching the global
            // `Mouse`/`Keyboard` here to keep the pattern module pure.
            elt.set_focus()
                .map_err(|e| backend("focus before close", e))?;
            elt.send_keys("%{F4}", 0)
                .map_err(|e| backend("Alt+F4 close", e))
        }
        WindowOp::Minimize | WindowOp::Maximize | WindowOp::Restore => {
            let p = elt
                .get_pattern::<UIWindowPattern>()
                .map_err(|e| pattern_unavailable("Window", e))?;
            let state = match op {
                WindowOp::Minimize => WindowVisualState::Minimized,
                WindowOp::Maximize => WindowVisualState::Maximized,
                _ => WindowVisualState::Normal,
            };
            p.set_window_visual_state(state)
                .map_err(|e| backend("WindowPattern.set_window_visual_state", e))
        }
        WindowOp::Resize { rect } => {
            let p = elt
                .get_pattern::<UITransformPattern>()
                .map_err(|e| pattern_unavailable("Transform", e))?;
            // Move first so the resize anchor is at (x, y).
            p.move_to(f64::from(rect.x), f64::from(rect.y))
                .map_err(|e| backend("Transform.move_to(resize)", e))?;
            p.resize(f64::from(rect.width), f64::from(rect.height))
                .map_err(|e| backend("Transform.resize", e))
        }
    }
}

/// Convert the TS-side WindowOp.op string into a typed enum.
fn parse_window_op(op: &str) -> Result<WindowOp> {
    match op {
        "focus" => Ok(WindowOp::Focus),
        "close" => Ok(WindowOp::Close),
        "minimize" => Ok(WindowOp::Minimize),
        "maximize" => Ok(WindowOp::Maximize),
        "restore" => Ok(WindowOp::Restore),
        other => Err(AutomationError::BackendError {
            message: format!("Window: unknown op '{other}'"),
        }),
    }
}

/// Map `ScrollOpts` deltas into UIA `ScrollAmount` increments. Each "wheel
/// notch" (120) is one Small{Increment,Decrement}; deltas of ≥240 (= 2
/// notches) map to Large{Increment,Decrement}. Returned tuple is
/// `(horizontal, vertical)`.
pub fn scroll_amounts(opts: ScrollOpts) -> (ScrollAmount, ScrollAmount) {
    fn classify(delta: i32) -> ScrollAmount {
        if delta == 0 {
            ScrollAmount::NoAmount
        } else if delta >= 240 {
            ScrollAmount::LargeIncrement
        } else if delta > 0 {
            ScrollAmount::SmallIncrement
        } else if delta <= -240 {
            ScrollAmount::LargeDecrement
        } else {
            ScrollAmount::SmallDecrement
        }
    }
    (classify(opts.dx), classify(opts.dy))
}

fn backend(label: &str, err: uiautomation::Error) -> AutomationError {
    AutomationError::BackendError {
        message: format!("{label}: {err}"),
    }
}

fn pattern_unavailable(name: &str, err: uiautomation::Error) -> AutomationError {
    AutomationError::BackendError {
        message: format!("element does not support {name} pattern: {err}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scroll_amounts_zero_maps_to_no_amount() {
        let (h, v) = scroll_amounts(ScrollOpts { dx: 0, dy: 0 });
        assert_eq!(h, ScrollAmount::NoAmount);
        assert_eq!(v, ScrollAmount::NoAmount);
    }

    #[test]
    fn scroll_amounts_small_positive_is_small_increment() {
        let (_h, v) = scroll_amounts(ScrollOpts { dx: 0, dy: 120 });
        assert_eq!(v, ScrollAmount::SmallIncrement);
    }

    #[test]
    fn scroll_amounts_large_negative_is_large_decrement() {
        let (_h, v) = scroll_amounts(ScrollOpts { dx: 0, dy: -300 });
        assert_eq!(v, ScrollAmount::LargeDecrement);
    }

    #[test]
    fn parse_window_op_recognises_known_ops() {
        assert!(matches!(parse_window_op("focus"), Ok(WindowOp::Focus)));
        assert!(matches!(parse_window_op("close"), Ok(WindowOp::Close)));
        assert!(matches!(
            parse_window_op("minimize"),
            Ok(WindowOp::Minimize)
        ));
        assert!(matches!(
            parse_window_op("maximize"),
            Ok(WindowOp::Maximize)
        ));
        assert!(matches!(parse_window_op("restore"), Ok(WindowOp::Restore)));
    }

    #[test]
    fn parse_window_op_rejects_unknown() {
        assert!(matches!(
            parse_window_op("bogus"),
            Err(AutomationError::BackendError { .. })
        ));
    }
}
