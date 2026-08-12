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
//! ADR-0020 cross-platform bounded subset (macOS): `read_tree` / `find` walk the
//! frontmost application's AX element subtree via the high-level `accessibility`
//! crate, capped through the shared `tree_shape` helper (depth + node budget).
//! `capabilities()` therefore reports `hasA11yTree: true`.
//!
//! The macOS follow-up (see `ax/raw.rs`) closed the "only window name" gap that
//! made the tree useless in practice:
//!
//!   - **AX trust gate** — an untrusted process gets `kAXErrorAPIDisabled` on
//!     every read, i.e. an empty tree. `read_tree` now fails loudly with an
//!     actionable message (and pops the system prompt) instead.
//!   - **Web-a11y activation** — Chromium / WebKit / Electron apps (Cognia's own
//!     WKWebView included) don't publish their web-content tree until an AT
//!     client sets `AXManualAccessibility` / `AXEnhancedUserInterface`.
//!   - **Focused-window root** — `AXWindows[0]` is often an empty helper window;
//!     the walk now roots at `AXFocusedWindow` / `AXMainWindow`.
//!   - **Rich nodes** — role, subrole (→ `class_name`), identifier (→
//!     `automation_id`), enabled/focused, a name fallback chain, and geometry
//!     (`AXPosition`/`AXSize` → `bounding_rect`).
//!
//! Coordinate hit-testing (`pick_at_point`) still resolves to the focused window
//! via osascript, and element-targeted actions (`invoke_pattern` / `window_op`
//! by ref) remain unsupported: a stable, re-resolvable element ref is the harder
//! follow-on.

mod locator;
mod observer;
mod raw;
mod screen_capture;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use accessibility::{AXUIElement, AXUIElementAttributes};
use enigo::{Direction, Enigo, Keyboard, Mouse, Settings};
use objc2::rc::autoreleasepool;
use objc2_app_kit::NSWorkspace;
use once_cell::sync::Lazy;

use crate::automation::backend::{ApplicationScreenshot, AutomationBackend, SelectionPreflight};
use crate::automation::platform::shared::element_locator;
use crate::automation::platform::shared::keymap::{parse_chord, KeyToken, Modifier, NamedKey};
use crate::automation::platform::shared::screenshot;
use crate::automation::platform::shared::tree_shape::{self, TreeBudget};
use crate::automation::selection::{build_text_selection, TextSelectionSnapshot};
use crate::automation::session::{AppLocator, ResolvedApplication};
use crate::automation::types::*;

#[derive(Default)]
pub struct AxBackend {
    /// The one observer thread, started on the first subscription and stopped
    /// when the last one goes away. Interior mutability because the trait takes
    /// `&self`; nothing here awaits, so no guard ever crosses a suspend point.
    events: Mutex<Option<observer::AxObserverHandle>>,
    subscriptions: Mutex<HashMap<u64, EventFilter>>,
    elements: Mutex<HashMap<String, AXUIElement>>,
    capture_stream: Mutex<Option<screen_capture::ActiveWindowCapture>>,
    next_subscription: AtomicU64,
}

impl AxBackend {
    pub fn new() -> std::result::Result<Self, String> {
        Ok(Self::default())
    }

    fn read_tree_for_application(
        &self,
        pid: u32,
        process_name: Option<&str>,
        budget: TreeBudget,
    ) -> Result<Vec<ElementInfo>> {
        let app = AXUIElement::application(pid as i32);
        raw::set_messaging_timeout(&app, 0.25);
        raw::activate_web_a11y(&app);
        let deadline = Instant::now() + Duration::from_secs(1);
        while !raw::has_visible_windows(&app) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(25));
        }
        let root = raw::resolve_window_root(&app);
        self.elements.lock().map_err(poisoned)?.clear();
        // The live-handle map stays as a same-process fast path (a ref acted on
        // right after the tree read skips the replay), but it is no longer the
        // ONLY way to resolve a ref: `resolve_element` falls back to replaying
        // the locator recipe, so a ref survives the next `read_tree` clearing
        // this map.
        let to_info = |element: &AXUIElement| {
            let mut info = ax_element_to_info(element, Some(pid), process_name);
            let handle_key = format!(
                "macos|pid={pid}|element={:x}",
                raw::element_identity(element)
            );
            if let Ok(mut elements) = self.elements.lock() {
                elements.insert(handle_key.clone(), element.clone());
            }
            info.element_ref = ElementRef(handle_key);
            info
        };
        let children = |element: &AXUIElement, limit: usize| -> Vec<AXUIElement> {
            raw::read_children_page(element, 0, limit)
        };
        let mut tree = tree_shape::walk_tree(&root, budget, &to_info, &children);

        // Stamp re-resolvable locators over the materialized tree. Derived from
        // the already-read fields, so this costs zero extra AX round-trips —
        // building each locator by walking up `AXParent` would be
        // O(nodes x depth) cross-process messages on a 25 000-node budget.
        // The live handles keep their old keys in `self.elements`, keyed by the
        // pointer identity, so both resolution paths stay available.
        let base = locator::locator_for_window_root(pid, process_name, None);
        element_locator::assign_locators(&mut tree, &base);
        Ok(vec![tree])
    }

    /// Resolve a ref to a live element.
    ///
    /// Two paths, in order:
    ///   1. **Live-handle cache** — a pointer-keyed handle from the most recent
    ///      `read_tree`. Free, but only valid until the next tree read clears
    ///      the map.
    ///   2. **Locator replay** — decode the ancestry recipe and walk it against
    ///      the live tree. This is what makes a ref outlive the cache, and what
    ///      makes refs from `find` / `pick_at_point` / `get_focus` actionable at
    ///      all; before Epic 5 those minted strings that were never cached and
    ///      so could only ever return `StaleElement`.
    ///
    /// A ref that is neither cached nor a decodable locator is stale — legacy
    /// `macos|pid=…` strings from a previous build land here and are refused
    /// rather than guessed at.
    fn resolve_element(&self, element_ref: &ElementRef) -> Result<AXUIElement> {
        if let Some(cached) = self
            .elements
            .lock()
            .map_err(poisoned)?
            .get(&element_ref.0)
            .cloned()
        {
            return Ok(cached);
        }
        match element_locator::ElementLocator::decode(&element_ref.0) {
            Some(loc) => locator::resolve_locator(&loc),
            None => Err(AutomationError::StaleElement),
        }
    }
}

impl Drop for AxBackend {
    fn drop(&mut self) {
        // The worker rebuilds its backend after a panic. Without this, every
        // panic would strand another live observer thread.
        let _ = self.events.lock().map(|mut slot| slot.take());
    }
}

impl AutomationBackend for AxBackend {
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            platform: Platform::Macos,
            has_uia: false,
            has_input_sim: true,
            has_screenshot: true,
            // AXObserver-backed selection/focus notifications (see `observer.rs`).
            has_events: true,
            has_a11y_tree: true, // bounded AX subtree via read_tree/find (ADR-0020 subset).
            monitors: screenshot::list_monitors(),
        }
    }

    fn get_focus(&self) -> Result<ElementInfo> {
        let snap = read_focused_window()?;
        Ok(focused_to_element_info(&snap))
    }

    fn list_applications(&self) -> Result<Vec<ResolvedApplication>> {
        Ok(running_applications())
    }

    fn resolve_application(
        &self,
        locator: &AppLocator,
        allow_launch: bool,
    ) -> Result<ResolvedApplication> {
        if let Some(app) = find_running_application(locator) {
            return Ok(app);
        }
        if !allow_launch {
            return Err(AutomationError::ElementNotFound);
        }
        let mut command = std::process::Command::new("/usr/bin/open");
        match locator {
            AppLocator::BundleId { bundle_id } => {
                command.args(["-b", bundle_id]);
            }
            AppLocator::Path { path } => {
                if !std::path::Path::new(path).is_absolute() {
                    return Err(AutomationError::BackendError {
                        message: "application path must be absolute".into(),
                    });
                }
                command.arg(path);
            }
            AppLocator::DisplayName { display_name } => {
                command.args(["-a", display_name]);
            }
        }
        let output = command
            .output()
            .map_err(|error| AutomationError::BackendError {
                message: format!("launch application: {error}"),
            })?;
        if !output.status.success() {
            return Err(AutomationError::BackendError {
                message: format!(
                    "launch application failed: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                ),
            });
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if let Some(app) = find_running_application(locator) {
                return Ok(app);
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        Err(AutomationError::BackendError {
            message: "application launched but did not become observable within 5 seconds".into(),
        })
    }

    fn read_tree(&self, _root: Option<ElementRef>, opts: TreeOpts) -> Result<Vec<ElementInfo>> {
        // Reading another process's AX tree requires this process to be trusted
        // for the Accessibility API. Untrusted, every attribute read returns
        // kAXErrorAPIDisabled and the walk would silently yield an empty tree —
        // fail loudly with an actionable message (and pop the system prompt once).
        if !raw::is_trusted() {
            raw::prompt_trust();
            return Err(AutomationError::PermissionDenied {
                reason: "macOS Accessibility permission not granted — enable Cognia in \
                         System Settings › Privacy & Security › Accessibility, then retry"
                    .into(),
            });
        }
        // Walk the frontmost application's focused-window subtree, depth- and
        // node-capped via the shared budget. We resolve the pid from the same
        // osascript snapshot the metadata path uses, then drive the AX accessors.
        // Element refs are observability-only (role/title) — they aren't
        // re-resolvable to a live AXUIElement, hence no element-targeted actions.
        let snap = read_focused_window()?;
        let Some(pid) = snap.pid else {
            return Err(AutomationError::BackendError {
                message: "no frontmost application pid".into(),
            });
        };
        self.read_tree_for_application(
            pid,
            snap.process_name.as_deref(),
            TreeBudget::from_opts(opts.max_depth),
        )
    }

    fn read_application_tree(
        &self,
        app: &ResolvedApplication,
        opts: TreeOpts,
    ) -> Result<Vec<ElementInfo>> {
        if !raw::is_trusted() {
            raw::prompt_trust();
            return Err(AutomationError::PermissionDenied {
                reason: "macOS Accessibility permission not granted".into(),
            });
        }
        self.read_tree_for_application(
            app.process_id,
            Some(app.display_name.as_str()),
            TreeBudget::from_opts(opts.max_depth),
        )
    }

    fn screenshot_application(
        &self,
        app: &ResolvedApplication,
        window_hint: Option<&ElementInfo>,
        opts: ScreenshotOpts,
    ) -> Result<ApplicationScreenshot> {
        screen_capture::capture_application_window(
            &self.capture_stream,
            app.process_id,
            window_hint,
            &opts,
        )
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
        screen_capture::capture_display(&opts)
    }

    fn click(&self, target: ClickTarget, opts: ClickOpts) -> Result<()> {
        match target {
            ClickTarget::Element { element_ref } => {
                let element = self.resolve_element(&element_ref)?;
                raw::perform_action(&element, "AXPress").map_err(|error| {
                    AutomationError::BackendError {
                        message: format!("AXPress failed with AXError {error}"),
                    }
                })
            }
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
                        std::thread::sleep(Duration::from_millis(50));
                    }
                }
                Ok(())
            }
        }
    }

    fn type_text(&self, text: &str, opts: TypeOpts) -> Result<()> {
        if let Some(target) = opts.target {
            let element = self.resolve_element(&target)?;
            raw::perform_action(&element, "AXRaise").ok();
        }
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
        target: ElementRef,
        pattern: PatternKind,
        args: serde_json::Value,
    ) -> Result<serde_json::Value> {
        let element = self.resolve_element(&target)?;
        match pattern {
            PatternKind::Invoke | PatternKind::Toggle | PatternKind::SelectionItem => {
                raw::perform_action(&element, "AXPress")
            }
            PatternKind::Value => {
                let value = args
                    .get("value")
                    .and_then(|value| value.as_str())
                    .ok_or_else(|| AutomationError::BackendError {
                        message: "AX value action requires a string `value`".into(),
                    })?;
                raw::set_string_value(&element, "AXValue", value)
            }
            PatternKind::Text => {
                let start = args
                    .get("start")
                    .and_then(|value| value.as_u64())
                    .ok_or_else(|| AutomationError::BackendError {
                        message: "AX text selection requires `start`".into(),
                    })? as usize;
                let end = args
                    .get("end")
                    .and_then(|value| value.as_u64())
                    .ok_or_else(|| AutomationError::BackendError {
                        message: "AX text selection requires `end`".into(),
                    })? as usize;
                raw::set_selected_text_range(&element, start, end)
            }
            PatternKind::ExpandCollapse => raw::perform_action(&element, "AXPress"),
            PatternKind::ScrollItem => raw::perform_action(&element, "AXScrollToVisible"),
            PatternKind::RangeValue | PatternKind::Window | PatternKind::Transform => {
                return Err(AutomationError::UnsupportedPlatform);
            }
        }
        .map_err(|error| AutomationError::BackendError {
            message: format!("AX semantic action failed with AXError {error}"),
        })?;
        Ok(serde_json::Value::Null)
    }

    fn window_op(&self, _t: ElementRef, _op: WindowOp) -> Result<()> {
        Err(AutomationError::UnsupportedPlatform)
    }

    fn subscribe_events(&self, f: EventFilter) -> Result<SubscriptionId> {
        if f.kinds.as_ref().is_some_and(Vec::is_empty) {
            return Err(AutomationError::BackendError {
                message: "subscribe_events: kinds must not be empty".into(),
            });
        }
        let id = self.next_subscription.fetch_add(1, Ordering::Relaxed) + 1;
        let mut events = self.events.lock().map_err(|error| poisoned(error))?;
        if events.is_none() {
            *events = Some(
                observer::AxObserverHandle::install(id)
                    .map_err(|message| AutomationError::BackendError { message })?,
            );
        }
        drop(events);
        self.subscriptions
            .lock()
            .map_err(|error| poisoned(error))?
            .insert(id, f);
        Ok(SubscriptionId(id))
    }

    fn unsubscribe(&self, s: SubscriptionId) -> Result<()> {
        let mut subscriptions = self.subscriptions.lock().map_err(|error| poisoned(error))?;
        if subscriptions.remove(&s.0).is_none() {
            return Err(AutomationError::BackendError {
                message: format!("unsubscribe: unknown subscription id {}", s.0),
            });
        }
        let empty = subscriptions.is_empty();
        drop(subscriptions);
        if empty {
            // Last one out stops the thread; an idle observer would keep
            // re-targeting on every app switch for nobody.
            self.events.lock().map_err(|error| poisoned(error))?.take();
        }
        Ok(())
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

    /// True coordinate hit-test via `AXUIElementCopyElementAtPosition`.
    ///
    /// This used to return the frontmost *window's* metadata regardless of the
    /// point, which made it impossible to tell what kind of control the cursor
    /// was actually over — a code editor, a browser address bar, a read-only
    /// document. The old behaviour is kept as the fallback rather than
    /// erroring: a miss (over the desktop, or an app that refuses hit-testing)
    /// should not regress the Inspector's pick affordance to a failure.
    fn pick_at_point(&self, point: Point) -> Result<ElementInfo> {
        if !raw::is_trusted() {
            return Err(AutomationError::PermissionDenied {
                reason: "macOS Accessibility permission not granted".into(),
            });
        }
        let Some(element) = raw::element_at_position(point.x as f32, point.y as f32) else {
            let snap = read_focused_window()?;
            return Ok(focused_to_element_info(&snap));
        };
        let pid = raw::element_pid(&element);
        // The cached focused-window snapshot already knows the frontmost
        // process's name; borrow it when the hit landed in that same process
        // (the overwhelmingly common case) rather than paying for another look-up.
        let focused = read_focused_window().ok();
        let process_name = focused
            .as_ref()
            .filter(|snap| pid.is_some() && snap.pid == pid)
            .and_then(|snap| snap.process_name.as_deref());
        let mut info = ax_element_to_info(&element, pid, process_name);
        // Before Epic 5 this handed back `macos|role=…|title=…`, which was never
        // in the handle cache and so could not be clicked, typed into, or
        // measured — picking an element produced a ref you could only look at.
        if let Some(pid) = pid {
            if let Some(loc) = locator::locator_for_element(&element, pid, process_name, None) {
                info.element_ref = ElementRef(loc.encode());
            }
        }
        Ok(info)
    }

    fn read_text_selection(&self) -> Result<Option<TextSelectionSnapshot>> {
        if !raw::is_trusted() {
            return Err(AutomationError::PermissionDenied {
                reason: "macOS Accessibility permission not granted".into(),
            });
        }
        let focused = read_focused_window()?;
        let Some(pid) = focused.pid else {
            return Ok(None);
        };
        let app = AXUIElement::application(pid as i32);
        raw::activate_web_a11y(&app);
        let Some(element) = raw::focused_ui_element(&app) else {
            return Ok(None);
        };
        if element
            .subrole()
            .ok()
            .is_some_and(|subrole| subrole == "AXSecureTextField")
        {
            return Ok(None);
        }
        let Some(text) = raw::selected_text(&element) else {
            return Ok(None);
        };
        Ok(build_text_selection(
            &text,
            focused.process_name.as_deref().unwrap_or("Unknown"),
            focused.window_title.as_deref(),
            raw::selected_text_bounds(&element),
        ))
    }

    /// Answered entirely through AX — no `osascript`.
    ///
    /// This runs on every gated pointer release, so the old
    /// `read_focused_window()` path (which shells out and caches for 250ms)
    /// would fork a process whenever the cache missed. `AXFocusedApplication`
    /// off the system-wide element is one mach round-trip and needs only the
    /// grant this backend already requires.
    fn selection_preflight(&self) -> Result<SelectionPreflight> {
        let trusted = raw::is_trusted();
        if !trusted {
            return Ok(SelectionPreflight {
                trusted: false,
                ..Default::default()
            });
        }
        let Some(pid) = raw::system_wide_focused_pid() else {
            return Ok(SelectionPreflight {
                trusted: true,
                ..Default::default()
            });
        };
        let app = AXUIElement::application(pid as i32);
        raw::set_messaging_timeout(&app, PREFLIGHT_TIMEOUT_SECONDS);
        let focused = raw::focused_ui_element(&app);
        let secure_field = focused
            .as_ref()
            .and_then(|element| element.subrole().ok())
            .is_some_and(|subrole| subrole == "AXSecureTextField");
        Ok(SelectionPreflight {
            pid: Some(pid),
            process_name: str_attr(app.title()),
            window_title: raw::resolve_window_root(&app).title().ok().and_then(|t| {
                let title = t.to_string();
                (!title.is_empty()).then_some(title)
            }),
            // Rides the round-trip we are already making — the focused element
            // is in hand, so walking to its web area costs no extra hop. Never
            // read for a password field.
            source_url: focused
                .as_ref()
                .filter(|_| !secure_field)
                .and_then(raw::web_area_url),
            secure_field,
            trusted: true,
        })
    }
}

/// The preflight sits on the pointer-release path, so a wedged app must cost
/// a fraction of a frame rather than the AX default of 6 seconds.
const PREFLIGHT_TIMEOUT_SECONDS: f32 = 0.25;

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

fn running_applications() -> Vec<ResolvedApplication> {
    autoreleasepool(|_| {
        let workspace = NSWorkspace::sharedWorkspace();
        let mut applications = workspace
            .runningApplications()
            .iter()
            .filter_map(|application| {
                let process_id = application.processIdentifier();
                if process_id <= 0 {
                    return None;
                }
                let display_name = application.localizedName()?.to_string();
                let bundle_id = application
                    .bundleIdentifier()
                    .map(|identifier| identifier.to_string());
                let path = application
                    .bundleURL()
                    .and_then(|url| url.path())
                    .map(|path| path.to_string());
                Some(ResolvedApplication {
                    bundle_id,
                    path,
                    display_name,
                    process_id: process_id as u32,
                })
            })
            .collect::<Vec<_>>();
        applications.sort_by(|left, right| {
            left.display_name
                .to_ascii_lowercase()
                .cmp(&right.display_name.to_ascii_lowercase())
                .then(left.process_id.cmp(&right.process_id))
        });
        applications
    })
}

fn find_running_application(locator: &AppLocator) -> Option<ResolvedApplication> {
    running_applications()
        .into_iter()
        .find(|application| match locator {
            AppLocator::BundleId { bundle_id } => application
                .bundle_id
                .as_deref()
                .is_some_and(|candidate| candidate.eq_ignore_ascii_case(bundle_id)),
            AppLocator::Path { path } => application.path.as_deref() == Some(path.as_str()),
            AppLocator::DisplayName { display_name } => {
                application.display_name.eq_ignore_ascii_case(display_name)
            }
        })
}

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

/// Whether this process holds the macOS Accessibility grant.
///
/// Narrow re-export of `raw::is_trusted` so the recorder's preflight can report
/// the grant without opening the whole `raw` FFI module up.
pub(crate) fn accessibility_trusted() -> bool {
    raw::is_trusted()
}

pub(crate) fn focused_window_credential_signals() -> Option<(Option<String>, Option<String>, bool)>
{
    if !raw::is_trusted() {
        return None;
    }
    let snap = read_focused_window().ok()?;
    let secure_text_field = snap
        .pid
        .map(|pid| raw::focused_element_is_secure_text_field(&AXUIElement::application(pid as i32)))
        .unwrap_or(false);
    Some((snap.process_name, snap.window_title, secure_text_field))
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

/// Ref for the focused window.
///
/// Prefers a re-resolvable locator rooted at the window; falls back to the
/// legacy observability string only when there is no pid to root it at (the
/// focused-window probe failed), where any ref would be unresolvable anyway.
fn focused_element_ref(snap: &FocusedSnapshot) -> ElementRef {
    match snap.pid {
        Some(pid) => ElementRef(
            locator::locator_for_window_root(pid, snap.process_name.as_deref(), None).encode(),
        ),
        None => snap_to_element_ref(snap),
    }
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

/// Convert a live AX element into our `ElementInfo`:
///
///   - `control_type` ← `AXRole`, `class_name` ← `AXSubrole`, `automation_id` ←
///     `AXIdentifier`.
///   - `name` ← first non-empty of `AXTitle` → `AXDescription` → string
///     `AXValue` → `AXRoleDescription` (most controls have no `AXTitle`).
///   - `is_enabled` / `is_focused` ← `AXEnabled` / `AXFocused`.
///   - `bounding_rect` ← `AXPosition` + `AXSize` (global screen coordinates).
///
/// All reads are best-effort; absent attributes fall back to sane defaults. The
/// ref is an observability string, not a re-resolvable handle.
/// A poisoned lock here means another thread panicked while holding backend
/// state. Report it rather than propagating the panic — the worker rebuilds
/// the backend on the next request.
fn poisoned<T>(error: std::sync::PoisonError<T>) -> AutomationError {
    AutomationError::BackendError {
        message: format!("ax backend lock poisoned: {error}"),
    }
}

fn ax_element_to_info(el: &AXUIElement, pid: Option<u32>, proc_name: Option<&str>) -> ElementInfo {
    let role = str_attr(el.role());
    let subrole = str_attr(el.subrole());
    let secure_field = subrole.as_deref() == Some("AXSecureTextField");
    let title = (!secure_field).then(|| str_attr(el.title())).flatten();
    let description = (!secure_field)
        .then(|| str_attr(el.description()))
        .flatten();
    let role_description = (!secure_field)
        .then(|| str_attr(el.role_description()))
        .flatten();
    let identifier = str_attr(el.identifier());
    let name = project_ax_name(
        secure_field,
        title.clone(),
        description,
        (!secure_field)
            .then(|| raw::read_value_string(el))
            .flatten(),
        role_description,
    );
    let element_ref = ElementRef(format!(
        "macos|role={}|title={}",
        role.as_deref().unwrap_or(""),
        name.as_deref().unwrap_or("")
    ));
    ElementInfo {
        element_ref,
        name,
        automation_id: identifier,
        control_type: role,
        class_name: subrole,
        bounding_rect: raw::read_rect(el),
        is_enabled: raw::read_bool(el, "AXEnabled").unwrap_or(true),
        is_focused: raw::read_bool(el, "AXFocused").unwrap_or(false),
        process_id: pid,
        process_name: proc_name.map(|s| s.to_string()),
        window_title: title,
        children: None,
    }
}

/// First non-empty AX name candidate, in priority order:
/// `AXTitle` → `AXDescription` → string `AXValue` → `AXRoleDescription`.
/// Pure so it's unit-tested on every host (including the Windows dev box where
/// this module doesn't compile — the logic still needs coverage).
fn pick_name(
    title: Option<String>,
    description: Option<String>,
    value: Option<String>,
    role_description: Option<String>,
) -> Option<String> {
    title.or(description).or(value).or(role_description)
}

fn project_ax_name(
    secure_field: bool,
    title: Option<String>,
    description: Option<String>,
    value: Option<String>,
    role_description: Option<String>,
) -> Option<String> {
    secure_field
        .then(|| "[REDACTED]".into())
        .or_else(|| pick_name(title, description, value, role_description))
}

/// Read a CFString-typed AX accessor result into a trimmed, non-empty `String`.
fn str_attr<S: ToString, E>(r: std::result::Result<S, E>) -> Option<String> {
    r.ok().map(|s| s.to_string()).filter(|s| !s.is_empty())
}

fn focused_to_element_info(snap: &FocusedSnapshot) -> ElementInfo {
    ElementInfo {
        element_ref: focused_element_ref(snap),
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
    fn focused_element_ref_is_a_replayable_locator_when_a_pid_is_known() {
        let snap = FocusedSnapshot {
            process_name: Some("Example".into()),
            window_title: Some("Untitled".into()),
            pid: Some(4242),
        };
        let r = focused_element_ref(&snap);
        let decoded = element_locator::ElementLocator::decode(&r.0)
            .expect("focus ref must be a decodable locator, not an observability string");
        assert_eq!(decoded.app.pid, 4242);
        assert_eq!(decoded.app.process_name.as_deref(), Some("Example"));
        // Rooted at the window: an empty path IS the window root.
        assert!(decoded.path.is_empty());
    }

    #[test]
    fn focused_element_ref_falls_back_to_the_legacy_marker_without_a_pid() {
        // No pid means no application to root a recipe at — any locator would
        // be unresolvable, so the observability string is the honest answer.
        let snap = FocusedSnapshot {
            process_name: None,
            window_title: Some("Untitled".into()),
            pid: None,
        };
        let r = focused_element_ref(&snap);
        assert!(r.0.starts_with("macos|"));
        assert!(element_locator::ElementLocator::decode(&r.0).is_none());
    }

    #[test]
    fn a_legacy_ref_from_a_previous_build_is_refused_not_guessed_at() {
        let backend = AxBackend::default();
        let err = backend
            .resolve_element(&ElementRef("macos|pid=42|element=7f00".into()))
            .expect_err("legacy refs must not resolve");
        assert!(matches!(err, AutomationError::StaleElement));
    }

    #[test]
    fn an_uncached_locator_for_a_dead_pid_reports_stale() {
        let backend = AxBackend::default();
        let mut loc = element_locator::ElementLocator::new(
            element_locator::LocatorBackend::Macos,
            element_locator::AppIdentity {
                // A pid that owns no accessible windows.
                pid: 999_999,
                bundle_id: None,
                process_name: None,
            },
        );
        loc.path = vec![element_locator::AncestryStep {
            role: Some("AXButton".into()),
            ..Default::default()
        }];
        let err = backend
            .resolve_element(&ElementRef(loc.encode()))
            .expect_err("a recipe that matches nothing must be stale");
        assert!(matches!(err, AutomationError::StaleElement));
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
    fn secure_field_projection_never_exposes_name_candidates() {
        assert_eq!(
            project_ax_name(
                true,
                Some("title-secret".into()),
                Some("description-secret".into()),
                Some("value-secret".into()),
                Some("role-secret".into()),
            )
            .as_deref(),
            Some("[REDACTED]")
        );
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

    #[test]
    fn pick_name_prefers_title_then_falls_back_in_order() {
        // Title wins when present.
        assert_eq!(
            pick_name(
                Some("Save".into()),
                Some("desc".into()),
                Some("val".into()),
                Some("button".into())
            )
            .as_deref(),
            Some("Save")
        );
        // Then description (most controls have no AXTitle).
        assert_eq!(
            pick_name(None, Some("Close window".into()), Some("val".into()), None).as_deref(),
            Some("Close window")
        );
        // Then a string AXValue (text fields).
        assert_eq!(
            pick_name(
                None,
                None,
                Some("hello@example.com".into()),
                Some("text field".into())
            )
            .as_deref(),
            Some("hello@example.com")
        );
        // Then the human-readable role description.
        assert_eq!(
            pick_name(None, None, None, Some("close button".into())).as_deref(),
            Some("close button")
        );
        // Nothing at all → unnamed.
        assert_eq!(pick_name(None, None, None, None), None);
    }
}
