//! R3 routing layer (ADR-0020 remote-target). Both backend-dispatch surfaces —
//! `dispatcher::execute_action` (the canonical renderer `desktop.*` client +
//! chat Plugin-MCP path) and the granular `desktop_*` typed commands — run each
//! action through these helpers *inside* the `run_gated` `do_call` closure, so
//! the permission gate / consent / audit pipeline wraps both local and remote
//! paths identically. When the `CallContext` carries a remote sandbox
//! connection id the action is translated to a `computer-server` WS command via
//! the `CuaRemoteClient`; otherwise it falls through to the local synchronous
//! worker (`AutomationHandle`).
//!
//! Critical invariant: EVERY driving / reading action is routed here. An action
//! that isn't would silently execute on the local host even for a remote
//! session. Actions with no remote equivalent return `UnsupportedPlatform` when
//! the target is remote — they never fall through to the host.

use std::sync::Arc;

use serde_json::{json, Value};

use super::commands::now_ms;
use super::types::*;
use super::worker::AutomationHandle;
use crate::cua_sandbox::protocol;
use crate::cua_sandbox::remote_client::CuaRemoteClient;
use crate::cua_sandbox::CuaSandboxRegistry;

async fn client(cua: &CuaSandboxRegistry, id: &str) -> Result<Arc<CuaRemoteClient>> {
    cua.client(id).await
}

fn button_name(button: MouseButton) -> &'static str {
    match button {
        MouseButton::Left => "left",
        MouseButton::Right => "right",
        MouseButton::Middle => "middle",
    }
}

// ---- driving / read actions with a remote equivalent ----------------------

pub async fn screenshot(
    handle: &AutomationHandle,
    cua: &CuaSandboxRegistry,
    remote: Option<&str>,
    opts: ScreenshotOpts,
) -> Result<Screenshot> {
    match remote {
        None => handle.screenshot(opts).await,
        Some(id) => {
            let c = client(cua, id).await?;
            let resp = c.call_simple(protocol::SCREENSHOT, json!({})).await?;
            let bytes = resp
                .get("image_data")
                .and_then(|v| v.as_str())
                .ok_or_else(|| AutomationError::BackendError {
                    message: "cua screenshot returned no image_data".into(),
                })?
                .to_string();
            // The container screenshot is full-screen; ask for screen size so
            // the renderer gets real dimensions.
            let (width, height) = match c.call_simple(protocol::SCREEN_SIZE, json!({})).await {
                Ok(s) => {
                    let size = s.get("size").unwrap_or(&s);
                    (
                        size.get("width").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
                        size.get("height").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
                    )
                }
                Err(_) => (0, 0),
            };
            Ok(Screenshot { bytes, width, height, captured_at: now_ms(), format: ImageFormat::Png })
        }
    }
}

pub async fn click(
    handle: &AutomationHandle,
    cua: &CuaSandboxRegistry,
    remote: Option<&str>,
    target: ClickTarget,
    opts: ClickOpts,
) -> Result<()> {
    match remote {
        None => handle.click(target, opts).await,
        Some(id) => {
            let point = match target {
                ClickTarget::Point { x, y } => Point { x, y },
                // Element-target clicks are UIA-only; the remote backend has no
                // element refs to resolve.
                ClickTarget::Element { .. } => return Err(AutomationError::UnsupportedPlatform),
            };
            let button = opts.button.unwrap_or(MouseButton::Left);
            let count = opts
                .count
                .unwrap_or(if opts.double == Some(true) { 2 } else { 1 });
            client(cua, id)
                .await?
                .call(protocol::click_request(point, button, count))
                .await
                .map(|_| ())
        }
    }
}

pub async fn type_text(
    handle: &AutomationHandle,
    cua: &CuaSandboxRegistry,
    remote: Option<&str>,
    text: String,
    opts: TypeOpts,
) -> Result<()> {
    match remote {
        None => handle.type_text(text, opts).await,
        Some(id) => client(cua, id)
            .await?
            .call(protocol::type_text_request(&text))
            .await
            .map(|_| ()),
    }
}

pub async fn send_keys(
    handle: &AutomationHandle,
    cua: &CuaSandboxRegistry,
    remote: Option<&str>,
    chord: KeyChord,
) -> Result<()> {
    match remote {
        None => handle.send_keys(chord).await,
        Some(id) => client(cua, id)
            .await?
            .call(protocol::keys_request(&chord))
            .await
            .map(|_| ()),
    }
}

pub async fn mouse_move(
    handle: &AutomationHandle,
    cua: &CuaSandboxRegistry,
    remote: Option<&str>,
    point: Point,
) -> Result<()> {
    match remote {
        None => handle.mouse_move(point).await,
        Some(id) => client(cua, id)
            .await?
            .call(protocol::move_request(point))
            .await
            .map(|_| ()),
    }
}

pub async fn drag(
    handle: &AutomationHandle,
    cua: &CuaSandboxRegistry,
    remote: Option<&str>,
    from: Point,
    to: Point,
    opts: DragOpts,
) -> Result<()> {
    match remote {
        None => handle.drag(from, to, opts).await,
        Some(id) => {
            let button = opts.button.unwrap_or(MouseButton::Left);
            let duration_secs = opts.duration_ms.unwrap_or(150) as f64 / 1000.0;
            client(cua, id)
                .await?
                .call(protocol::drag_request(from, to, button, duration_secs))
                .await
                .map(|_| ())
        }
    }
}

pub async fn scroll(
    handle: &AutomationHandle,
    cua: &CuaSandboxRegistry,
    remote: Option<&str>,
    target: ScrollTarget,
    opts: ScrollOpts,
) -> Result<()> {
    match remote {
        None => handle.scroll(target, opts).await,
        Some(id) => {
            let c = client(cua, id).await?;
            // cua scrolls at the current cursor; move there first for fidelity.
            if let ScrollTarget::Point { x, y } = target {
                c.call(protocol::move_request(Point { x, y })).await?;
            }
            c.call(protocol::scroll_request(&opts)).await.map(|_| ())
        }
    }
}

pub async fn hold_key(
    handle: &AutomationHandle,
    cua: &CuaSandboxRegistry,
    remote: Option<&str>,
    chord: KeyChord,
    duration_ms: u32,
) -> Result<()> {
    match remote {
        None => handle.hold_key(chord, duration_ms).await,
        Some(id) => {
            let c = client(cua, id).await?;
            let keys: Vec<String> = chord
                .0
                .split('+')
                .map(|t| t.trim().to_string())
                .filter(|t| !t.is_empty())
                .collect();
            for k in &keys {
                c.call(protocol::key_transition_request(k, true)).await?;
            }
            tokio::time::sleep(std::time::Duration::from_millis(duration_ms as u64)).await;
            for k in keys.iter().rev() {
                c.call(protocol::key_transition_request(k, false)).await?;
            }
            Ok(())
        }
    }
}

pub async fn mouse_button(
    handle: &AutomationHandle,
    cua: &CuaSandboxRegistry,
    remote: Option<&str>,
    button: MouseButton,
    transition: ButtonTransition,
) -> Result<()> {
    match remote {
        None => handle.mouse_button(button, transition).await,
        Some(id) => {
            // cua x/y are optional; omitting them acts at the current cursor.
            let command = match transition {
                ButtonTransition::Down => "mouse_down",
                ButtonTransition::Up => "mouse_up",
            };
            client(cua, id)
                .await?
                .call_simple(command, json!({ "button": button_name(button) }))
                .await
                .map(|_| ())
        }
    }
}

pub async fn cursor_position(
    handle: &AutomationHandle,
    cua: &CuaSandboxRegistry,
    remote: Option<&str>,
) -> Result<Point> {
    match remote {
        None => handle.cursor_position().await,
        Some(id) => {
            let resp = client(cua, id)
                .await?
                .call_simple(protocol::CURSOR_POSITION, json!({}))
                .await?;
            let pos = resp.get("position").unwrap_or(&resp);
            let x = pos.get("x").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            let y = pos.get("y").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            Ok(Point { x, y })
        }
    }
}

pub async fn read_tree(
    handle: &AutomationHandle,
    cua: &CuaSandboxRegistry,
    remote: Option<&str>,
    root: Option<ElementRef>,
    opts: TreeOpts,
) -> Result<Vec<ElementInfo>> {
    match remote {
        None => handle.read_tree(root, opts).await,
        Some(id) => {
            let resp = client(cua, id)
                .await?
                .call_simple(protocol::ACCESSIBILITY_TREE, json!({}))
                .await?;
            // The server wraps the root node under `tree`/`nodes` depending on
            // version; fall back to the response object itself.
            let root_node = resp
                .get("tree")
                .or_else(|| resp.get("nodes"))
                .unwrap_or(&resp);
            Ok(flatten_a11y(root_node, 0))
        }
    }
}

// ---- actions with no remote equivalent: never fall through to the host -----

pub async fn get_focus(
    handle: &AutomationHandle,
    _cua: &CuaSandboxRegistry,
    remote: Option<&str>,
) -> Result<ElementInfo> {
    match remote {
        None => handle.get_focus().await,
        Some(_) => Err(AutomationError::UnsupportedPlatform),
    }
}

pub async fn find(
    handle: &AutomationHandle,
    _cua: &CuaSandboxRegistry,
    remote: Option<&str>,
    locator: Locator,
) -> Result<Option<ElementRef>> {
    match remote {
        None => handle.find(locator).await,
        Some(_) => Err(AutomationError::UnsupportedPlatform),
    }
}

pub async fn invoke_pattern(
    handle: &AutomationHandle,
    _cua: &CuaSandboxRegistry,
    remote: Option<&str>,
    target: ElementRef,
    pattern: PatternKind,
    args: Value,
) -> Result<Value> {
    match remote {
        None => handle.invoke_pattern(target, pattern, args).await,
        Some(_) => Err(AutomationError::UnsupportedPlatform),
    }
}

pub async fn window_op(
    handle: &AutomationHandle,
    _cua: &CuaSandboxRegistry,
    remote: Option<&str>,
    target: ElementRef,
    op: WindowOp,
) -> Result<()> {
    match remote {
        None => handle.window_op(target, op).await,
        Some(_) => Err(AutomationError::UnsupportedPlatform),
    }
}

pub async fn pick_at_point(
    handle: &AutomationHandle,
    _cua: &CuaSandboxRegistry,
    remote: Option<&str>,
    point: Point,
) -> Result<ElementInfo> {
    match remote {
        None => handle.pick_at_point(point).await,
        Some(_) => Err(AutomationError::UnsupportedPlatform),
    }
}

/// Best-effort recursive map of a cua `AccessibilityNode` (`role` / `title` /
/// `bounds{x,y,width,height}` / `children`) into cognia `ElementInfo`. Synthetic
/// element refs (`cua:<depth>:<index>`) keep the renderer's tree happy; remote
/// refs aren't re-resolvable (find/invoke_pattern return UnsupportedPlatform).
fn flatten_a11y(node: &Value, depth: usize) -> Vec<ElementInfo> {
    fn one(node: &Value, depth: usize, index: usize) -> ElementInfo {
        let bounds = node.get("bounds");
        let bounding_rect = bounds.map(|b| Rect {
            x: b.get("x").and_then(|v| v.as_i64()).unwrap_or(0) as i32,
            y: b.get("y").and_then(|v| v.as_i64()).unwrap_or(0) as i32,
            width: b.get("width").and_then(|v| v.as_i64()).unwrap_or(0) as i32,
            height: b.get("height").and_then(|v| v.as_i64()).unwrap_or(0) as i32,
        });
        let children = node
            .get("children")
            .and_then(|c| c.as_array())
            .map(|arr| {
                arr.iter()
                    .enumerate()
                    .map(|(i, child)| one(child, depth + 1, i))
                    .collect::<Vec<_>>()
            });
        ElementInfo {
            element_ref: ElementRef(format!("cua:{depth}:{index}")),
            name: node.get("title").and_then(|v| v.as_str()).map(String::from),
            automation_id: None,
            control_type: node.get("role").and_then(|v| v.as_str()).map(String::from),
            class_name: None,
            bounding_rect,
            is_enabled: true,
            is_focused: false,
            process_id: None,
            process_name: None,
            window_title: None,
            children,
        }
    }

    if node.is_object() {
        vec![one(node, depth, 0)]
    } else if let Some(arr) = node.as_array() {
        arr.iter().enumerate().map(|(i, n)| one(n, depth, i)).collect()
    } else {
        Vec::new()
    }
}
