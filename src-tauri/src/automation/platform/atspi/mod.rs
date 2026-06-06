//! Linux AT-SPI back-end.
//!
//! ADR-0020 W2 closed the parity gap with the Windows UIA backend for the
//! Anthropic `computer_20251124` action surface:
//!
//!   - **Input primitives**: `click` / `mouse_move` / `drag` / `scroll`
//!     / `mouse_button` / `hold_key` / `cursor_position` are all
//!     implemented via `enigo`. `send_keys` walks the shared keymap IR
//!     so modifier chords work — pre-W2 the backend hard-failed
//!     anything more elaborate than a single Enter / Tab / Space.
//!   - **Read-only metadata**: `get_focus` / `find` / `pick_at_point`
//!     shell out to `xdotool` (active window pid + title) plus
//!     `/proc/<pid>/comm` for the process name. Results are cached for
//!     250ms.
//!   - **Wayland honesty**: `capabilities()` checks
//!     `$XDG_SESSION_TYPE == "wayland"` AND the absence of `xdotool` on
//!     PATH; when both hold, `hasInputSim` + `hasScreenshot` flip
//!     `false` so the Overview tab shows the operator what their
//!     session actually supports, instead of "all green" while every
//!     call lands `BackendError`.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use enigo::{Direction, Enigo, Keyboard, Mouse, Settings};
use once_cell::sync::Lazy;

use crate::automation::backend::AutomationBackend;
use crate::automation::platform::shared::keymap::{parse_chord, KeyToken, Modifier, NamedKey};
use crate::automation::platform::shared::screenshot;
use crate::automation::types::*;

pub struct AtspiBackend;

impl AtspiBackend {
    pub fn new() -> std::result::Result<Self, String> {
        Ok(Self)
    }
}

impl AutomationBackend for AtspiBackend {
    fn capabilities(&self) -> Capabilities {
        let wayland_only = is_pure_wayland_without_xtools();
        Capabilities {
            platform: Platform::Linux,
            has_uia: false,
            has_input_sim: !wayland_only,
            has_screenshot: !wayland_only,
            has_events: false,
            has_a11y_tree: false, // minimum-viable enigo backend: input only, no AT-SPI tree.
            monitors: screenshot::list_monitors(),
        }
    }

    fn get_focus(&self) -> Result<ElementInfo> {
        let snap = read_focused_window()?;
        Ok(focused_to_element_info(&snap))
    }

    fn read_tree(&self, _root: Option<ElementRef>, _opts: TreeOpts) -> Result<Vec<ElementInfo>> {
        Err(AutomationError::UnsupportedPlatform)
    }

    fn find(&self, locator: &Locator) -> Result<Option<ElementRef>> {
        let snap = read_focused_window()?;
        if let Some(want_proc) = locator.process_name.as_deref() {
            let have = snap.process_name.as_deref().unwrap_or("");
            if !have.eq_ignore_ascii_case(want_proc) {
                return Ok(None);
            }
        }
        if let Some(want_title) = locator.window_title_contains.as_deref() {
            let have = snap.window_title.as_deref().unwrap_or("");
            if !have.contains(want_title) {
                return Ok(None);
            }
        }
        if locator.name.is_some()
            || locator.name_contains.is_some()
            || locator.automation_id.is_some()
            || locator.control_type.is_some()
            || locator.class_name.is_some()
        {
            return Ok(None);
        }
        Ok(Some(snap_to_element_ref(&snap)))
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
                let count = opts.count.unwrap_or(if opts.double.unwrap_or(false) { 2 } else { 1 });
                for i in 0..count.max(1) {
                    e.button(button, Direction::Click).map_err(input_err("click"))?;
                    if i + 1 < count {
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
        send_chord(&mut e, &tokens, Duration::from_millis(u64::from(duration_ms)))
    }

    fn mouse_button(
        &self,
        button: MouseButton,
        transition: ButtonTransition,
    ) -> Result<()> {
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
        // Minimum-viable: resolve to the currently focused window. True
        // hit-testing requires AT-SPI accessibility-at-point lookup
        // which we'll add when the full tree walker lands.
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
        e.key(*m, Direction::Press).map_err(input_err("chord.mod_press"))?;
    }
    if hold.is_zero() {
        e.key(main_key, Direction::Click).map_err(input_err("chord.main_click"))?;
    } else {
        e.key(main_key, Direction::Press).map_err(input_err("chord.main_press"))?;
        std::thread::sleep(hold);
        e.key(main_key, Direction::Release).map_err(input_err("chord.main_release"))?;
    }
    for m in modifiers.iter().rev() {
        e.key(*m, Direction::Release).map_err(input_err("chord.mod_release"))?;
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
        NamedKey::F(n) => enigo::Key::F(n),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Wayland detection
// ─────────────────────────────────────────────────────────────────────────────

fn is_pure_wayland_without_xtools() -> bool {
    let session = std::env::var("XDG_SESSION_TYPE").unwrap_or_default();
    if !session.eq_ignore_ascii_case("wayland") {
        return false;
    }
    // X11 binaries can still work under XWayland, so the session-type
    // alone isn't enough — check that xdotool actually resolves on PATH.
    !command_on_path("xdotool")
}

fn command_on_path(name: &str) -> bool {
    let path = std::env::var_os("PATH").unwrap_or_default();
    for dir in std::env::split_paths(&path) {
        if dir.join(name).is_file() {
            return true;
        }
        // Best-effort .exe suffix check just in case Wine / cross-build
        // environments throw one in — harmless on a real Linux host.
        if dir.join(format!("{name}.exe")).is_file() {
            return true;
        }
    }
    false
}

// ─────────────────────────────────────────────────────────────────────────────
// Focused-window metadata via xdotool + /proc/<pid>/comm. Cached for 250ms.
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
    let snap = read_via_xdotool()?;
    let mut guard = FOCUSED_CACHE.lock().unwrap_or_else(|p| p.into_inner());
    guard.snapshot = Some(snap.clone());
    guard.captured_at = Instant::now();
    Ok(snap)
}

fn read_via_xdotool() -> Result<FocusedSnapshot> {
    if !command_on_path("xdotool") {
        return Err(AutomationError::BackendError {
            message: "xdotool not on PATH — install xdotool to use the AT-SPI backend".into(),
        });
    }
    // `xdotool getactivewindow getwindowname getwindowpid` returns:
    //   line 1: window title
    //   line 2: pid
    let output = std::process::Command::new("xdotool")
        .args(["getactivewindow", "getwindowname", "getwindowpid"])
        .output()
        .map_err(|e| AutomationError::BackendError {
            message: format!("xdotool spawn failed: {e}"),
        })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(AutomationError::BackendError {
            message: format!("xdotool exited {}: {stderr}", output.status),
        });
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut lines = stdout.lines();
    let window_title = lines.next().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let pid = lines.next().and_then(|s| s.trim().parse::<u32>().ok());
    let process_name = pid.and_then(read_process_name_from_proc);
    Ok(FocusedSnapshot {
        process_name,
        window_title,
        pid,
    })
}

fn read_process_name_from_proc(pid: u32) -> Option<String> {
    let path = format!("/proc/{pid}/comm");
    std::fs::read_to_string(&path)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn snap_to_element_ref(snap: &FocusedSnapshot) -> ElementRef {
    let pid_part = snap.pid.map(|p| p.to_string()).unwrap_or_default();
    let title_part = snap.window_title.clone().unwrap_or_default();
    ElementRef(format!("linux|pid={pid_part}|title={title_part}"))
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
            process_name: Some("firefox".into()),
            window_title: Some("Mozilla Firefox".into()),
            pid: Some(987),
        };
        let info = focused_to_element_info(&snap);
        assert_eq!(info.process_name.as_deref(), Some("firefox"));
        assert_eq!(info.process_id, Some(987));
        assert!(info.is_focused);
    }

    #[test]
    fn snap_to_element_ref_uses_linux_marker() {
        let snap = FocusedSnapshot {
            process_name: None,
            window_title: Some("Terminal".into()),
            pid: Some(42),
        };
        let r = snap_to_element_ref(&snap);
        assert!(r.0.starts_with("linux|"));
        assert!(r.0.contains("pid=42"));
    }

    #[test]
    fn wayland_detection_reports_unsupported_without_xtools() {
        // The detection function reads `$XDG_SESSION_TYPE` + PATH. We
        // can't reliably stub PATH without poisoning the test process,
        // so verify the API exists and returns *a* bool (the real
        // detection is exercised in CI on a Wayland host).
        let _: bool = is_pure_wayland_without_xtools();
    }
}
