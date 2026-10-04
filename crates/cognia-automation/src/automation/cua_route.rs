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
            let _desktop = cua.agent_guard(id).await?;
            crate::cua_sandbox::desktop_session::capture(client(cua, id).await?.as_ref()).await
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
            let mut desktop = cua.agent_guard(id).await?;
            desktop.sessions = super::session::UiSessionManager::default();
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
            let action = super::session::UiAction::Click {
                button: Some(button),
                count: Some(count),
            };
            crate::cua_sandbox::desktop_session::validate_action(Some(point), &action)?;
            let c = client(cua, id).await?;
            desktop
                .run_mutation(crate::cua_sandbox::desktop_session::deliver(
                    &c,
                    Some(point),
                    &action,
                ))
                .await
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
        Some(id) => {
            if opts.target.is_some() || opts.delay_ms.is_some_and(|delay| delay > 0) {
                return Err(AutomationError::UnsupportedPlatform);
            }
            let mut desktop = cua.agent_guard(id).await?;
            desktop.sessions = super::session::UiSessionManager::default();
            let c = client(cua, id).await?;
            desktop
                .run_mutation(c.call(protocol::type_text_request(&text)))
                .await
                .map(|_| ())
        }
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
        Some(id) => {
            let mut desktop = cua.agent_guard(id).await?;
            desktop.sessions = super::session::UiSessionManager::default();
            crate::cua_sandbox::desktop_session::validate_action(
                None,
                &super::session::UiAction::PressKey {
                    chord: chord.clone(),
                },
            )?;
            let c = client(cua, id).await?;
            desktop
                .run_mutation(c.call(protocol::keys_request(&chord)))
                .await
                .map(|_| ())
        }
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
        Some(id) => {
            let mut desktop = cua.agent_guard(id).await?;
            desktop.sessions = super::session::UiSessionManager::default();
            let c = client(cua, id).await?;
            desktop
                .run_mutation(c.call(protocol::move_request(point)))
                .await
                .map(|_| ())
        }
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
            let mut desktop = cua.agent_guard(id).await?;
            desktop.sessions = super::session::UiSessionManager::default();
            let button = opts.button.unwrap_or(MouseButton::Left);
            let duration_secs = opts.duration_ms.unwrap_or(150) as f64 / 1000.0;
            let c = client(cua, id).await?;
            desktop
                .run_mutation(c.call(protocol::drag_request(from, to, button, duration_secs)))
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
            let mut desktop = cua.agent_guard(id).await?;
            desktop.sessions = super::session::UiSessionManager::default();
            let c = client(cua, id).await?;
            let point = match target {
                ScrollTarget::Point { x, y } => Point { x, y },
                ScrollTarget::Element { .. } => return Err(AutomationError::UnsupportedPlatform),
            };
            desktop
                .run_mutation(async {
                    c.call(protocol::move_request(point)).await?;
                    c.call(protocol::scroll_request(&opts)).await.map(|_| ())
                })
                .await
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
            let mut desktop = cua.agent_guard(id).await?;
            desktop.sessions = super::session::UiSessionManager::default();
            let c = client(cua, id).await?;
            let keys: Vec<String> = chord
                .0
                .split('+')
                .map(|t| t.trim().to_string())
                .filter(|t| !t.is_empty())
                .collect();
            if keys.is_empty() {
                return Err(AutomationError::BackendError {
                    message: "key chord is empty".into(),
                });
            }
            desktop
                .run_mutation(async {
                    for k in &keys {
                        c.call(protocol::key_transition_request(k, true)).await?;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(duration_ms as u64)).await;
                    for k in keys.iter().rev() {
                        c.call(protocol::key_transition_request(k, false)).await?;
                    }
                    Ok(())
                })
                .await
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
            let mut desktop = cua.agent_guard(id).await?;
            desktop.sessions = super::session::UiSessionManager::default();
            // cua x/y are optional; omitting them acts at the current cursor.
            let command = match transition {
                ButtonTransition::Down => "mouse_down",
                ButtonTransition::Up => "mouse_up",
            };
            let c = client(cua, id).await?;
            desktop
                .run_mutation(c.call_simple(command, json!({ "button": button_name(button) })))
                .await?;
            match transition {
                ButtonTransition::Down if !desktop.held_mouse_buttons.contains(&button) => {
                    desktop.held_mouse_buttons.push(button)
                }
                ButtonTransition::Up => desktop.held_mouse_buttons.retain(|held| *held != button),
                _ => {}
            }
            Ok(())
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
            let _desktop = cua.agent_guard(id).await?;
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
            if root.is_some() {
                return Err(AutomationError::UnsupportedPlatform);
            }
            let _desktop = cua.agent_guard(id).await?;
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
fn json_coord(value: Option<i64>) -> i32 {
    value
        .unwrap_or(0)
        .clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
}

fn json_dimension(value: Option<i64>) -> i32 {
    value.unwrap_or(0).clamp(0, i64::from(i32::MAX)) as i32
}

pub(crate) fn flatten_a11y(node: &Value, depth: usize) -> Vec<ElementInfo> {
    fn one(node: &Value, depth: usize, next: &mut usize) -> Option<ElementInfo> {
        if depth > 64 || *next >= super::session::INSPECTOR_TREE_MAX_NODES || !node.is_object() {
            return None;
        }
        let index = *next;
        *next += 1;
        let bounds = node.get("bounds");
        let bounding_rect = bounds.map(|b| Rect {
            x: json_coord(b.get("x").and_then(|v| v.as_i64())),
            y: json_coord(b.get("y").and_then(|v| v.as_i64())),
            width: json_dimension(b.get("width").and_then(|v| v.as_i64())),
            height: json_dimension(b.get("height").and_then(|v| v.as_i64())),
        });
        let children = node.get("children").and_then(|c| c.as_array()).map(|arr| {
            arr.iter()
                .filter_map(|child| one(child, depth + 1, next))
                .collect::<Vec<_>>()
        });
        Some(ElementInfo {
            element_ref: ElementRef(format!("cua:{index}")),
            name: node
                .get("title")
                .or_else(|| node.get("name"))
                .and_then(|v| v.as_str())
                .map(String::from),
            automation_id: None,
            control_type: node.get("role").and_then(|v| v.as_str()).map(String::from),
            class_name: None,
            bounding_rect,
            is_enabled: node.get("enabled").and_then(Value::as_bool).unwrap_or(true),
            is_focused: node
                .get("focused")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            process_id: None,
            process_name: None,
            window_title: None,
            children,
        })
    }
    let mut next = 0;
    if let Some(arr) = node.as_array() {
        arr.iter()
            .filter_map(|n| one(n, depth, &mut next))
            .collect()
    } else {
        one(node, depth, &mut next).into_iter().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn flatten_a11y_assigns_distinct_refs_across_sibling_subtrees() {
        let nodes = flatten_a11y(
            &json!({"children":[{"children":[{"title":"a"}]},{"children":[{"title":"b"}]}]}),
            0,
        );
        let parents = nodes[0].children.as_ref().unwrap();
        assert_ne!(
            parents[0].children.as_ref().unwrap()[0].element_ref,
            parents[1].children.as_ref().unwrap()[0].element_ref
        );
    }

    #[test]
    fn flatten_a11y_saturates_untrusted_bounds_without_wrapping() {
        let node = json!({
            "title": "Launch",
            "role": "button",
            "bounds": {
                "x": i64::from(i32::MAX) + 5,
                "y": i64::from(i32::MIN) - 5,
                "width": -10,
                "height": i64::from(i32::MAX) + 1
            }
        });

        let flattened = flatten_a11y(&node, 0);
        let rect = flattened[0].bounding_rect.as_ref().unwrap();

        assert_eq!(rect.x, i32::MAX);
        assert_eq!(rect.y, i32::MIN);
        assert_eq!(rect.width, 0);
        assert_eq!(rect.height, i32::MAX);
    }
}
