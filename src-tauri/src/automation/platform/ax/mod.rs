//! macOS AXAPI back-end.
//!
//! ADR-0020 W2 closed the parity gap with the Windows UIA backend for the
//! Anthropic `computer_20251124` action surface:
//!
//!   - **Input primitives**: every method on `AutomationBackend` that the
//!     model can reach (`click` / `mouse_move` / `drag` / `scroll` /
//!     `mouse_button` / `hold_key` / `cursor_position`) is implemented
//!     via `enigo`. `send_keys` walks the shared keymap IR so modifier
//!     chords (`ctrl+shift+t`) work — pre-W2 they hard-failed.
//!   - **Read-only metadata**: `get_focus` / `find` / `pick_at_point`
//!     shell out to `osascript` (frontmost app + window title via System
//!     Events). Results are cached for 250ms so a flurry of
//!     `Whitelist::matches` calls during a single tool turn doesn't
//!     re-fork the shell. Locator support is restricted to
//!     `processName` / `windowTitleContains`; deeper AXUIElement tree
//!     walking is out of scope for the minimum-viable surface.
//!
//! ADR-0020 cross-platform bounded subset (macOS): `read_tree` / `find` now
//! walk the frontmost application's AX element subtree via the high-level
//! `accessibility` crate, capped through the shared `tree_shape` helper (depth +
//! node budget). `capabilities()` therefore reports `hasA11yTree: true`.
//! Coordinate hit-testing (`pick_at_point`) stays on the osascript frontmost-
//! window path: `AXUIElementCopyElementAtPosition` would force a raw-`-sys` ref
//! wrap across the `accessibility` crate's older core-foundation pin, which
//! can't be verified from the Windows dev host — left as Phase-next. Element-
//! targeted actions (`click`/`scroll`/`invoke_pattern`/`window_op` by ref) also
//! remain coordinate-only / unsupported: a stable, re-resolvable element ref is
//! the harder follow-on.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use accessibility::{AXUIElement, AXUIElementAttributes};
use enigo::{Direction, Enigo, Keyboard, Mouse, Settings};
use once_cell::sync::Lazy;

use crate::automation::backend::AutomationBackend;
use crate::automation::platform::shared::keymap::{parse_chord, KeyToken, Modifier, NamedKey};
use crate::automation::platform::shared::screenshot;
use crate::automation::platform::shared::tree_shape::{self, TreeBudget};
use crate::automation::types::*;

pub struct AxBackend;

impl AxBackend {
    pub fn new() -> std::result::Result<Self, String> {
        Ok(Self)
    }
}

impl AutomationBackend for AxBackend {
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            platform: Platform::Macos,
            has_uia: false,
            has_input_sim: true,
            has_screenshot: true,
            has_events: false,
            has_a11y_tree: true, // bounded AX subtree via read_tree/find (ADR-0020 subset).
            monitors: screenshot::list_monitors(),
        }
    }

    fn get_focus(&self) -> Result<ElementInfo> {
        let snap = read_focused_window()?;
        Ok(focused_to_element_info(&snap))
    }

    fn read_tree(&self, _root: Option<ElementRef>, opts: TreeOpts) -> Result<Vec<ElementInfo>> {
        // Walk the frontmost application's focused-window subtree, depth- and
        // node-capped via the shared budget. We resolve the pid from the same
        // osascript snapshot the metadata path uses, then drive the high-level
        // AX accessors. Element refs are observability-only (role/title) — they
        // aren't re-resolvable to a live AXUIElement, hence no element-targeted
        // actions yet.
        let snap = read_focused_window()?;
        let Some(pid) = snap.pid else {
            return Err(AutomationError::BackendError {
                message: "no frontmost application pid".into(),
            });
        };
        let budget = TreeBudget::from_opts(opts.max_depth);
        let app = AXUIElement::application(pid as i32);
        // `AXFocusedWindow`/`AXMainWindow` have no generated accessor in
        // accessibility 0.1.6, and reading them via the raw attribute API would
        // pull that crate's older core-foundation types across the version
        // boundary this module deliberately avoids. Root the walk at the app's
        // first window instead — `AXWindows` is front-to-back ordered, so this
        // is the frontmost (active) window — falling back to the application
        // element (whose children are its windows) when none is exposed.
        let root = app
            .windows()
            .ok()
            .and_then(|w| w.iter().next().map(|c| (*c).clone()))
            .unwrap_or_else(|| app.clone());
        let proc_name = snap.process_name.as_deref();
        let to_info = |el: &AXUIElement| ax_element_to_info(el, Some(pid), proc_name);
        let children = |el: &AXUIElement| -> Vec<AXUIElement> {
            el.children()
                .map(|arr| arr.iter().map(|c| (*c).clone()).collect())
                .unwrap_or_default()
        };
        let tree = tree_shape::walk_tree(&root, budget, &to_info, &children);
        Ok(vec![tree])
    }

    fn find(&self, locator: &Locator) -> Result<Option<ElementRef>> {
        // Materialize the bounded frontmost-window subtree, then delegate the
        // (cross-platform) matching to tree_shape. This now satisfies
        // name / name_contains / control_type constraints — not just
        // processName / windowTitleContains as the pre-subset metadata path did.
        let trees = self.read_tree(None, TreeOpts::default())?;
        for tree in &trees {
            if let Some(found) = tree_shape::find_in_tree(tree, locator) {
                return Ok(Some(found));
            }
        }
        Ok(None)
    }

    fn screenshot(&self, opts: ScreenshotOpts) -> Result<Screenshot> {
        screenshot::capture_primary(&opts)
    }

    fn click(&self, target: ClickTarget, opts: ClickOpts) -> Result<()> {
        match target {
            ClickTarget::Element { .. } => Err(AutomationError::UnsupportedPlatform),
            ClickTarget::Point { x, y } => {
                let mut e = enigo_new()?;
                e.move_mouse(x, y, enigo::Coordinate::Abs)
                    .map_err(input_err("mouse move"))?;
                let button = to_enigo_button(opts.button);
                let count = opts
                    .count
                    .unwrap_or(if opts.double.unwrap_or(false) { 2 } else { 1 });
                for i in 0..count.max(1) {
                    e.button(button, Direction::Click)
                        .map_err(input_err("click"))?;
                    if i + 1 < count {
                        // Spacing to fall inside the typical macOS
                        // double-click threshold (500ms). 50ms is far
                        // enough below it to register as a multi-click.
                        std::thread::sleep(Duration::from_millis(50));
                    }
                }
                Ok(())
            }
        }
    }

    fn type_text(&self, text: &str, _opts: TypeOpts) -> Result<()> {
        let mut e = enigo_new()?;
        e.text(text).map_err(input_err("type_text"))
    }

    fn send_keys(&self, chord: &KeyChord) -> Result<()> {
        let tokens = parse_chord(&chord.0).map_err(|e| AutomationError::BackendError {
            message: format!("send_keys: {e}"),
        })?;
        let mut e = enigo_new()?;
        send_chord(&mut e, &tokens, Duration::ZERO)
    }

    fn invoke_pattern(
        &self,
        _t: ElementRef,
        _p: PatternKind,
        _a: serde_json::Value,
    ) -> Result<serde_json::Value> {
        Err(AutomationError::UnsupportedPlatform)
    }

    fn window_op(&self, _t: ElementRef, _op: WindowOp) -> Result<()> {
        Err(AutomationError::UnsupportedPlatform)
    }

    fn subscribe_events(&self, _f: EventFilter) -> Result<SubscriptionId> {
        Err(AutomationError::UnsupportedPlatform)
    }

    fn unsubscribe(&self, _s: SubscriptionId) -> Result<()> {
        Err(AutomationError::UnsupportedPlatform)
    }

    fn mouse_move(&self, point: Point) -> Result<()> {
        let mut e = enigo_new()?;
        e.move_mouse(point.x, point.y, enigo::Coordinate::Abs)
            .map_err(input_err("mouse_move"))
    }

    fn drag(&self, from: Point, to: Point, _opts: DragOpts) -> Result<()> {
        let mut e = enigo_new()?;
        e.move_mouse(from.x, from.y, enigo::Coordinate::Abs)
            .map_err(input_err("drag.move_start"))?;
        e.button(enigo::Button::Left, Direction::Press)
            .map_err(input_err("drag.press"))?;
        e.move_mouse(to.x, to.y, enigo::Coordinate::Abs)
            .map_err(input_err("drag.move_end"))?;
        e.button(enigo::Button::Left, Direction::Release)
            .map_err(input_err("drag.release"))
    }

    fn scroll(&self, target: ScrollTarget, opts: ScrollOpts) -> Result<()> {
        let mut e = enigo_new()?;
        if let ScrollTarget::Point { x, y } = target {
            e.move_mouse(x, y, enigo::Coordinate::Abs)
                .map_err(input_err("scroll.move"))?;
        }
        // enigo's `scroll(amount, axis)` uses notch-sized increments (positive
        // = forward / down). Our wire format is wheel units (120 per notch).
        let notches_y = opts.dy / 120;
        let notches_x = opts.dx / 120;
        if notches_y != 0 {
            e.scroll(notches_y, enigo::Axis::Vertical)
                .map_err(input_err("scroll.vertical"))?;
        }
        if notches_x != 0 {
            e.scroll(notches_x, enigo::Axis::Horizontal)
                .map_err(input_err("scroll.horizontal"))?;
        }
        Ok(())
    }

    fn hold_key(&self, chord: &KeyChord, duration_ms: u32) -> Result<()> {
        let tokens = parse_chord(&chord.0).map_err(|e| AutomationError::BackendError {
            message: format!("hold_key: {e}"),
        })?;
        let mut e = enigo_new()?;
        send_chord(
            &mut e,
            &tokens,
            Duration::from_millis(u64::from(duration_ms)),
        )
    }

    fn mouse_button(&self, button: MouseButton, transition: ButtonTransition) -> Result<()> {
        let mut e = enigo_new()?;
        let b = to_enigo_button(Some(button));
        let dir = match transition {
            ButtonTransition::Down => Direction::Press,
            ButtonTransition::Up => Direction::Release,
        };
        e.button(b, dir).map_err(input_err("mouse_button"))
    }

    fn cursor_position(&self) -> Result<Point> {
        let e = enigo_new()?;
        let (x, y) = e.location().map_err(input_err("cursor_position"))?;
        Ok(Point { x, y })
    }

    fn pick_at_point(&self, _point: Point) -> Result<ElementInfo> {
        // macOS minimum-viable: `pick_at_point` resolves to whichever
        // element System Events identifies as the frontmost app's
        // window. Cursor-coordinate-based hit-testing requires
        // AXUIElementCopyElementAtPosition; out of scope for W2 but the
        // Inspector still gets a useful result (the focused window's
        // metadata) so the affordance isn't a no-op.
        let snap = read_focused_window()?;
        Ok(focused_to_element_info(&snap))
    }
}

fn enigo_new() -> Result<Enigo> {
    Enigo::new(&Settings::default()).map_err(|e| AutomationError::BackendError {
        message: format!("enigo init failed: {e}"),
    })
}

fn to_enigo_button(b: Option<MouseButton>) -> enigo::Button {
    match b.unwrap_or(MouseButton::Left) {
        MouseButton::Left => enigo::Button::Left,
        MouseButton::Right => enigo::Button::Right,
        MouseButton::Middle => enigo::Button::Middle,
    }
}

fn input_err(label: &'static str) -> impl Fn(enigo::InputError) -> AutomationError {
    move |e| AutomationError::BackendError {
        message: format!("{label}: {e}"),
    }
}

/// Press modifiers, fire / hold the main key, release modifiers. When
/// `hold` is `Duration::ZERO` the main key fires once (W2 `send_keys`);
/// otherwise the main key is pressed-and-held for `hold` then released
/// (W2 `hold_key`). All errors propagate through the same
/// `BackendError` channel.
fn send_chord(e: &mut Enigo, tokens: &[KeyToken], hold: Duration) -> Result<()> {
    let mut modifiers: Vec<enigo::Key> = Vec::new();
    let mut main: Option<enigo::Key> = None;
    for tok in tokens {
        match tok {
            KeyToken::Modifier(m) => modifiers.push(modifier_to_enigo(*m)),
            KeyToken::Named(n) => main = Some(named_to_enigo(*n)),
            KeyToken::Char(c) => main = Some(enigo::Key::Unicode(*c)),
        }
    }
    let Some(main_key) = main else {
        return Err(AutomationError::BackendError {
            message: "chord has no main key".into(),
        });
    };
    for m in &modifiers {
        e.key(*m, Direction::Press)
            .map_err(input_err("chord.mod_press"))?;
    }
    if hold.is_zero() {
        e.key(main_key, Direction::Click)
            .map_err(input_err("chord.main_click"))?;
    } else {
        e.key(main_key, Direction::Press)
            .map_err(input_err("chord.main_press"))?;
        std::thread::sleep(hold);
        e.key(main_key, Direction::Release)
            .map_err(input_err("chord.main_release"))?;
    }
    for m in modifiers.iter().rev() {
        e.key(*m, Direction::Release)
            .map_err(input_err("chord.mod_release"))?;
    }
    Ok(())
}

fn modifier_to_enigo(m: Modifier) -> enigo::Key {
    match m {
        Modifier::Shift => enigo::Key::Shift,
        Modifier::Control => enigo::Key::Control,
        Modifier::Alt => enigo::Key::Alt,
        Modifier::Meta => enigo::Key::Meta,
    }
}

fn named_to_enigo(n: NamedKey) -> enigo::Key {
    match n {
        NamedKey::Enter => enigo::Key::Return,
        NamedKey::Tab => enigo::Key::Tab,
        NamedKey::Escape => enigo::Key::Escape,
        NamedKey::Backspace => enigo::Key::Backspace,
        NamedKey::Delete => enigo::Key::Delete,
        NamedKey::Space => enigo::Key::Space,
        NamedKey::Home => enigo::Key::Home,
        NamedKey::End => enigo::Key::End,
        NamedKey::PageUp => enigo::Key::PageUp,
        NamedKey::PageDown => enigo::Key::PageDown,
        NamedKey::ArrowUp => enigo::Key::UpArrow,
        NamedKey::ArrowDown => enigo::Key::DownArrow,
        NamedKey::ArrowLeft => enigo::Key::LeftArrow,
        NamedKey::ArrowRight => enigo::Key::RightArrow,
        NamedKey::F(n) => function_key_to_enigo(n),
    }
}

/// Map a function-key number (`F1`–`F24`, the range accepted by
/// `parse_function_key`) onto enigo's discrete `Key::F1`…`Key::F20` variants.
/// enigo 0.6 has no `Key::F(n)` tuple variant — each function key is its own
/// enum variant — and on macOS it only defines through `F20` (`F21`–`F24` are
/// gated to Windows / non-macOS unix). `F21`–`F24` therefore clamp to `F20`,
/// the highest function key the macOS backend can synthesize. The remaining
/// `_` arm is unreachable: `parse_function_key` rejects anything outside
/// `1..=24` before a `NamedKey::F` is ever constructed.
fn function_key_to_enigo(n: u8) -> enigo::Key {
    match n {
        1 => enigo::Key::F1,
        2 => enigo::Key::F2,
        3 => enigo::Key::F3,
        4 => enigo::Key::F4,
        5 => enigo::Key::F5,
        6 => enigo::Key::F6,
        7 => enigo::Key::F7,
        8 => enigo::Key::F8,
        9 => enigo::Key::F9,
        10 => enigo::Key::F10,
        11 => enigo::Key::F11,
        12 => enigo::Key::F12,
        13 => enigo::Key::F13,
        14 => enigo::Key::F14,
        15 => enigo::Key::F15,
        16 => enigo::Key::F16,
        17 => enigo::Key::F17,
        18 => enigo::Key::F18,
        19 => enigo::Key::F19,
        20..=24 => enigo::Key::F20,
        _ => enigo::Key::F1,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Focused-window metadata via `osascript`. Cached for 250ms.
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct FocusedSnapshot {
    process_name: Option<String>,
    window_title: Option<String>,
    pid: Option<u32>,
}

struct FocusedCache {
    snapshot: Option<FocusedSnapshot>,
    captured_at: Instant,
}

static FOCUSED_CACHE: Lazy<Mutex<FocusedCache>> = Lazy::new(|| {
    Mutex::new(FocusedCache {
        snapshot: None,
        captured_at: Instant::now() - Duration::from_secs(60),
    })
});

const FOCUS_CACHE_TTL: Duration = Duration::from_millis(250);

fn read_focused_window() -> Result<FocusedSnapshot> {
    {
        let guard = FOCUSED_CACHE.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(snap) = guard.snapshot.as_ref() {
            if guard.captured_at.elapsed() < FOCUS_CACHE_TTL {
                return Ok(snap.clone());
            }
        }
    }
    let snap = fork_osascript()?;
    let mut guard = FOCUSED_CACHE.lock().unwrap_or_else(|p| p.into_inner());
    guard.snapshot = Some(snap.clone());
    guard.captured_at = Instant::now();
    Ok(snap)
}

fn fork_osascript() -> Result<FocusedSnapshot> {
    // Single AppleScript run that returns three lines:
    //   line 1: front process name
    //   line 2: front process PID
    //   line 3: front window name (or empty)
    let script = r#"tell application "System Events"
    set frontApp to first process whose frontmost is true
    set procName to name of frontApp
    set procPid to unix id of frontApp
    set winName to ""
    try
        set winName to name of front window of frontApp
    end try
end tell
return procName & "\n" & procPid & "\n" & winName"#;
    let output = std::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|e| AutomationError::BackendError {
            message: format!("osascript spawn failed: {e}"),
        })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(AutomationError::BackendError {
            message: format!("osascript exited {}: {stderr}", output.status),
        });
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut lines = stdout.lines();
    let process_name = lines
        .next()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let pid = lines.next().and_then(|s| s.trim().parse::<u32>().ok());
    let window_title = lines
        .next()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    Ok(FocusedSnapshot {
        process_name,
        window_title,
        pid,
    })
}

fn snap_to_element_ref(snap: &FocusedSnapshot) -> ElementRef {
    // Opaque ref convention on macOS: "macos|pid=<n>|title=<title>".
    // The renderer never inspects the inner string — it just passes it
    // back to subsequent calls — so we use a printable shape that's
    // helpful when debugging audit rows.
    let pid_part = snap.pid.map(|p| p.to_string()).unwrap_or_default();
    let title_part = snap.window_title.clone().unwrap_or_default();
    ElementRef(format!("macos|pid={pid_part}|title={title_part}"))
}

/// Convert a live AX element into our `ElementInfo`. Reads role → `control_type`
/// and title → `name` / `window_title` (both best-effort; AX accessors return
/// `Err` when the attribute is absent). `bounding_rect` is left `None` — geometry
/// (`AXPosition`/`AXSize` are `AXValue`-wrapped) is a follow-on; the bounded
/// subset only needs role/title for `read_tree` + `find`. The ref is an
/// observability string, not a re-resolvable handle.
fn ax_element_to_info(el: &AXUIElement, pid: Option<u32>, proc_name: Option<&str>) -> ElementInfo {
    let role = el
        .role()
        .ok()
        .map(|r| r.to_string())
        .filter(|s| !s.is_empty());
    let title = el
        .title()
        .ok()
        .map(|t| t.to_string())
        .filter(|s| !s.is_empty());
    let element_ref = ElementRef(format!(
        "macos|role={}|title={}",
        role.as_deref().unwrap_or(""),
        title.as_deref().unwrap_or("")
    ));
    ElementInfo {
        element_ref,
        name: title.clone(),
        automation_id: None,
        control_type: role,
        class_name: None,
        bounding_rect: None,
        is_enabled: true,
        is_focused: false,
        process_id: pid,
        process_name: proc_name.map(|s| s.to_string()),
        window_title: title,
        children: None,
    }
}

fn focused_to_element_info(snap: &FocusedSnapshot) -> ElementInfo {
    ElementInfo {
        element_ref: snap_to_element_ref(snap),
        name: snap.window_title.clone(),
        automation_id: None,
        control_type: None,
        class_name: None,
        bounding_rect: None,
        is_enabled: true,
        is_focused: true,
        process_id: snap.pid,
        process_name: snap.process_name.clone(),
        window_title: snap.window_title.clone(),
        children: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn focused_to_element_info_passes_metadata_through() {
        let snap = FocusedSnapshot {
            process_name: Some("Safari".into()),
            window_title: Some("Apple - Start".into()),
            pid: Some(1234),
        };
        let info = focused_to_element_info(&snap);
        assert_eq!(info.process_name.as_deref(), Some("Safari"));
        assert_eq!(info.process_id, Some(1234));
        assert_eq!(info.window_title.as_deref(), Some("Apple - Start"));
        assert!(info.is_focused);
    }

    #[test]
    fn snap_to_element_ref_uses_macos_marker_for_observability() {
        let snap = FocusedSnapshot {
            process_name: None,
            window_title: Some("Untitled".into()),
            pid: Some(42),
        };
        let r = snap_to_element_ref(&snap);
        assert!(r.0.starts_with("macos|"));
        assert!(r.0.contains("pid=42"));
    }

    #[test]
    fn function_keys_map_to_discrete_enigo_variants() {
        assert_eq!(function_key_to_enigo(1), enigo::Key::F1);
        assert_eq!(function_key_to_enigo(12), enigo::Key::F12);
        assert_eq!(function_key_to_enigo(19), enigo::Key::F19);
        // macOS enigo caps at F20; F20–F24 all clamp to F20.
        assert_eq!(function_key_to_enigo(20), enigo::Key::F20);
        assert_eq!(function_key_to_enigo(24), enigo::Key::F20);
        // Out-of-range is unreachable via the parser but must stay total.
        assert_eq!(function_key_to_enigo(0), enigo::Key::F1);
        assert_eq!(function_key_to_enigo(99), enigo::Key::F1);
    }

    #[test]
    fn named_f_key_routes_through_function_key_map() {
        assert_eq!(named_to_enigo(NamedKey::F(5)), enigo::Key::F5);
    }
}
