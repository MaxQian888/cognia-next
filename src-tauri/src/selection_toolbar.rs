//! System-wide text-selection toolbar.
//!
//! The coordinator is intentionally native: it observes passive OS input,
//! reads AX/UIA selections on the automation worker, and owns the transient
//! overlay window even while the main Cognia webview is hidden in the tray.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Runtime, State, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::automation::commands::AutomationState;
use crate::automation::input_monitor::{InputButton, InputEvent, InputSubscription};
use crate::automation::platform::shared::credential_window;
use crate::automation::selection::{build_text_selection, TextSelectionSnapshot};
use crate::automation::selection_events::{self, SelectionSubscription};
use crate::automation::types::{EventFilter, EventKind, Point, Rect, SubscriptionId};

pub const SELECTION_TOOLBAR_LABEL: &str = "selection-toolbar";
pub const SELECTION_CANDIDATE_EVENT: &str = "selection://candidate";
pub const SELECTION_DISMISS_EVENT: &str = "selection://dismiss";
pub const SELECTION_STAGE_EVENT: &str = "selection://stage";
/// Rust → toolbar renderer: a bound global chord fired while a candidate is
/// live. Carries the shortcut id so the renderer can run the same code path a
/// click would.
pub const SELECTION_SHORTCUT_EVENT: &str = "selection://shortcut";
/// Rust → toolbar renderer: Escape was pressed while the toolbar owned focus.
/// Lets an open sub-panel close itself before Escape means "dismiss the whole
/// toolbar", which is what every other layered popover does.
pub const SELECTION_ESCAPE_EVENT: &str = "selection://escape";

/// Placeholder size the window is created with. The renderer measures the
/// capsule on mount and calls `selection_toolbar_resize` before revealing the
/// window, so this size is never on screen — it only has to be non-zero.
const MIN_TOOLBAR_WIDTH: f64 = 160.0;
const MIN_TOOLBAR_HEIGHT: f64 = 48.0;
const EDGE_MARGIN: i32 = 8;
const IDLE_DISMISS_MS: u64 = 10_000;
/// How often the idle watchdog re-checks the deadline. Coarse on purpose: the
/// deadline is 10s and the only thing this granularity costs is up to half a
/// second of extra dwell after the pointer leaves.
const IDLE_TICK_MS: u64 = 500;
/// Grace period between emitting a non-interrupting dismiss and actually
/// hiding the native window, so the renderer's exit animation is on screen.
/// Must stay >= the renderer's exit duration.
const EXIT_ANIMATION_MS: u64 = 160;
/// How long a stray key press waits for an action chord to claim it before it
/// counts as "the user has moved on". Long enough to cover the gap between the
/// HID tap and the global-shortcut handler, short enough that dismissing on a
/// real keystroke still feels immediate.
const SHORTCUT_CLAIM_GRACE_MS: u64 = 180;

/// How far the pointer must travel between press and release before the
/// release counts as a drag-selection. Above AppKit's own ~3pt drag slop, so a
/// shaky click is still a click.
const DRAG_THRESHOLD_PX: i32 = 6;
/// Ceiling for consecutive clicks to count as a double / triple click. Matches
/// the macOS default double-click interval.
const MULTI_CLICK_MS: i64 = 500;
/// How far consecutive clicks may drift and still be "the same spot".
const MULTI_CLICK_SLOP_PX: i32 = 4;
/// Quiet period a changing selection must hold before the toolbar appears.
///
/// Keyboard selection (⇧→ held down) emits one notification per keystroke; without
/// this the capsule would strobe under the caret. Also absorbs the burst an
/// app emits while it settles after a drag.
const SELECTION_SETTLE_MS: u64 = 350;
/// Selections larger than this never raise the toolbar on their own.
///
/// ⌘A in a document is the case that matters: the user is about to delete or
/// replace everything, not translate it, and a capsule appearing over the
/// selection is pure obstruction. They can still use the action chords.
/// Distinct from — and far below — `MAX_SELECTION_CHARS`, which is the
/// *storage* cap applied once text is actually read.
const SELECTION_MAX_AUTO_RAISE_CHARS: i64 = 4_000;

/// Where a publish attempt came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SelectionTrigger {
    /// An `AXSelectedTextChanged` notification that has since settled.
    AxObserver,
    /// A gated pointer release, for applications that post no notifications.
    Click,
}

/// A pointer press, remembered so the matching release can be classified.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PressRecord {
    x: i32,
    y: i32,
    ts_ms: i64,
}

/// What a pointer release meant.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ClickIntent {
    /// The pointer travelled — the user dragged out a selection. Carries the
    /// bounding box, which is also the OCR fallback's capture region.
    Drag { bounds: Rect },
    /// Two or more clicks in the same spot — select-word / select-paragraph.
    MultiClick { count: u32 },
    /// A plain click. Selects nothing, so it costs nothing.
    Ignore,
}

/// Classify a pointer release, and carry the multi-click counter forward.
///
/// This is the whole point of the gate: before it, *every* left-button release
/// anywhere on the desktop spawned a task that slept 60ms, did an AX selection
/// read, and on failure slept another 120ms and read again. A plain click
/// cannot have produced a selection, so it should cost nothing at all.
fn classify_release(
    press: Option<PressRecord>,
    release: PressRecord,
    previous_release: Option<PressRecord>,
    previous_count: u32,
) -> (ClickIntent, u32) {
    let count = match previous_release {
        Some(previous)
            if release.ts_ms.saturating_sub(previous.ts_ms) <= MULTI_CLICK_MS
                && (release.x - previous.x).abs() <= MULTI_CLICK_SLOP_PX
                && (release.y - previous.y).abs() <= MULTI_CLICK_SLOP_PX =>
        {
            previous_count.saturating_add(1)
        }
        _ => 1,
    };

    if let Some(press) = press {
        let dx = release.x - press.x;
        let dy = release.y - press.y;
        if dx.abs() >= DRAG_THRESHOLD_PX || dy.abs() >= DRAG_THRESHOLD_PX {
            return (
                ClickIntent::Drag {
                    bounds: Rect {
                        x: press.x.min(release.x),
                        y: press.y.min(release.y),
                        width: dx.abs(),
                        height: dy.abs(),
                    },
                },
                count,
            );
        }
    }

    if count >= 2 {
        (ClickIntent::MultiClick { count }, count)
    } else {
        (ClickIntent::Ignore, count)
    }
}

/// Decide which layer owns this pointer release, if either.
///
/// The two layers must not both read the same selection. The deciding question
/// is not "does this application generally post notifications" but the much
/// narrower "did it post one *for the gesture that is ending right now*" —
/// which is exactly what an armed settle timer means.
///
/// That distinction matters. Keying off an app's past behaviour needs a pid to
/// compare against, and the only pid available at mouse-up comes from the last
/// notification — so the comparison would be true by construction, and a user
/// moving from a talkative app (Safari) to a silent one (Terminal) inside the
/// trust window would have their drag routed to a layer that never fires.
/// Asking about the current gesture has no such window and needs no pid:
///
/// - Talkative app: notifications arrive during the drag, the settle is armed,
///   the release defers, and the settle fires immediately after (the mid-drag
///   interlock has just been released).
/// - Silent app: nothing armed it, so the release reads the selection itself.
fn resolve_trigger(intent: ClickIntent, settle_armed: bool) -> Option<SelectionTrigger> {
    if settle_armed {
        return Some(SelectionTrigger::AxObserver);
    }
    match intent {
        ClickIntent::Drag { .. } | ClickIntent::MultiClick { .. } => Some(SelectionTrigger::Click),
        ClickIntent::Ignore => None,
    }
}

/// Debounce state for observer-driven selections.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct SettleState {
    deadline_ms: Option<i64>,
}

/// What a selection signal should do to the settle timer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SettleAction {
    /// (Re-)start the quiet period. Re-arming pushes the deadline *later*,
    /// which is what makes a burst of keystrokes collapse into one publish.
    Arm { deadline_ms: i64 },
    /// The selection emptied — take the toolbar away immediately.
    DismissNow,
    /// Too large to raise on its own, or nothing to act on.
    Ignore,
}

fn settle_decision(signal_len: i64, now_ms: i64) -> SettleAction {
    if signal_len == 0 {
        return SettleAction::DismissNow;
    }
    if signal_len > SELECTION_MAX_AUTO_RAISE_CHARS {
        return SettleAction::Ignore;
    }
    // `signal_len < 0` means the platform could not measure it (Windows UIA).
    // Arm anyway and re-check the real size after the text is read.
    SettleAction::Arm {
        deadline_ms: now_ms.saturating_add(SELECTION_SETTLE_MS as i64),
    }
}

/// Action shortcuts, bound while the feature is running and released when it
/// stops. Deliberately *not* in `shortcuts::registry::seed_builtins` — that
/// binds unconditionally at startup, which would squat six global chords even
/// for users who never enable the selection toolbar.
///
/// Same `alt+shift+…` family as the pre-existing
/// `selection.captureClipboard = alt+shift+c`.
pub const SELECTION_ACTION_SHORTCUTS: &[(&str, &str)] = &[
    ("selection.copy", "alt+shift+1"),
    ("selection.explain", "alt+shift+2"),
    ("selection.translate", "alt+shift+3"),
    ("selection.ask", "alt+shift+4"),
    ("selection.remember", "alt+shift+5"),
    ("selection.speak", "alt+shift+6"),
];
const DEFAULT_BLOCKED_APPS: &[&str] = &[
    "1password",
    "authy",
    "bitwarden",
    "cognia",
    "dashlane",
    "keepass",
    "keychain access",
    "lastpass",
    "microsoft authenticator",
];

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SelectionOrigin {
    Accessibility,
    Clipboard,
    /// Read off the screen with OCR because the accessibility API exposed no
    /// text (images, PDF viewers, Java apps, remote desktops).
    ///
    /// A distinct variant rather than a sibling boolean because it is a
    /// different *trust level*, and it travels: this text may be handed to a
    /// model or written into long-term memory, and both of those want to say
    /// so. Recognition errors are ordinary here in a way they never are for a
    /// selection the user made in a real text control.
    Ocr,
}

/// Which side of the selection the toolbar ended up on. `clamp_toolbar_position`
/// has always made this choice (it flips below when the anchor hugs the top of
/// the work area) but never told the renderer, so the enter animation could not
/// grow *out of* the selection. Returned from `selection_toolbar_resize`
/// because the answer can flip once the real measured height is known.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ToolbarPlacement {
    Above,
    Below,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionToolbarGeometry {
    pub placement: ToolbarPlacement,
}

/// Why the toolbar is going away. The renderer animates the exit for `Idle` and
/// `Completed`, but an `Interrupted` dismiss means the user is already doing
/// something else — lingering there for 160ms would cover whatever they just
/// clicked, so that one hides synchronously.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DismissReason {
    Interrupted,
    Idle,
    Completed,
}

impl DismissReason {
    fn is_animated(self) -> bool {
        !matches!(self, DismissReason::Interrupted)
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct DismissPayload {
    reason: DismissReason,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalSelectionCandidate {
    pub id: String,
    pub text: String,
    pub source_app: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_title: Option<String>,
    pub origin: SelectionOrigin,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor_rect: Option<Rect>,
    pub captured_at: i64,
    pub truncated: bool,
    /// AX subrole of the source element (`AXSecureTextField`, `AXTextArea`, …).
    /// The renderer uses it to withhold actions, never to display anything.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_subrole: Option<String>,
    /// Page URL when the source application exposes one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
}

impl ExternalSelectionCandidate {
    fn from_snapshot(snapshot: TextSelectionSnapshot, origin: SelectionOrigin) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            text: snapshot.text,
            source_app: snapshot.source_app,
            source_title: snapshot.source_title,
            origin,
            anchor_rect: snapshot.anchor_rect,
            captured_at: chrono::Utc::now().timestamp_millis(),
            truncated: snapshot.truncated,
            source_subrole: None,
            source_url: None,
        }
    }

    /// Attach what the element hit-test learned about where the text came
    /// from. Separate from `from_snapshot` because the OCR path has no element
    /// to inspect — it only has pixels.
    fn with_source_element(mut self, subrole: Option<String>, url: Option<String>) -> Self {
        self.source_subrole = subrole;
        self.source_url = url;
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SelectionToolbarAction {
    Copy,
    Explain,
    Translate {
        target_locale: String,
    },
    Ask,
    Remember,
    Speak,
    /// Contextual. The renderer's classifier decided the selection was a link
    /// — but this payload is a UX hint, not authority. `open_target` re-parses
    /// it and refuses anything that is not http(s).
    OpenLink {
        url: String,
    },
    ComposeEmail {
        address: String,
    },
    /// Only the engine id crosses the boundary; the query is the live
    /// candidate's text, which Rust already owns, and the URL template lives
    /// here so a renderer string never reaches the OS opener uninspected.
    SearchWeb {
        engine: String,
    },
    ConvertUnit,
}

/// Search endpoints as `(id, base, query parameter)`.
///
/// Kept in Rust so the renderer names an engine rather than handing over a
/// URL, and split into base + parameter rather than a string template so the
/// query goes through `url`'s encoder instead of being concatenated.
const SEARCH_ENGINES: &[(&str, &str, &str)] = &[
    ("google", "https://www.google.com/search", "q"),
    ("bing", "https://www.bing.com/search", "q"),
    ("duckduckgo", "https://duckduckgo.com/", "q"),
    ("baidu", "https://www.baidu.com/s", "wd"),
];

impl SelectionToolbarAction {
    /// Whether handing this action to the main window should also raise it.
    ///
    /// Explain / translate / ask put a prompt in the composer and the answer is
    /// only readable there, so the window has to come forward. Remember and
    /// speak complete without the user ever looking at the app — raising it
    /// would interrupt whatever they were doing, which is the entire value of
    /// "just stash this" / "just read this out".
    fn focuses_main(&self) -> bool {
        matches!(
            self,
            SelectionToolbarAction::Explain
                | SelectionToolbarAction::Translate { .. }
                | SelectionToolbarAction::Ask
                // Same shape as the three above: it stages a prompt whose
                // answer is only readable in the composer.
                | SelectionToolbarAction::ConvertUnit
        )
    }

    /// Whether the toolbar stays on screen after dispatching, letting the
    /// renderer decide when to leave.
    ///
    /// True for everything that finishes *here* rather than in the main window:
    /// copy needs its checkmark to be on screen for a moment, remember has to
    /// report whether the PII gate let it through (that gate *returns*
    /// `{ok:false}` rather than throwing, so leaving early would turn a blocked
    /// memory into a silent no-op), and speak drives a player until playback
    /// ends. False for the three handoff actions — the main window has come
    /// forward and the user is looking at that, not at us.
    /// Whether this action hands off to something outside Cognia entirely.
    ///
    /// These raise the *browser* or the mail client, so neither the main
    /// window nor the toolbar should linger.
    fn launches_externally(&self) -> bool {
        matches!(
            self,
            SelectionToolbarAction::OpenLink { .. }
                | SelectionToolbarAction::ComposeEmail { .. }
                | SelectionToolbarAction::SearchWeb { .. }
        )
    }

    /// Whether the toolbar stays on screen after dispatching.
    ///
    /// This used to be `!focuses_main()`, and that identity held only while
    /// every action either raised the main window or completed in place.
    /// `launch` does neither — it raises a *third* application — so the answer
    /// has to be enumerated rather than derived. Leaving an always-on-top pill
    /// floating beside a browser that is already in front is exactly the lag
    /// the synchronous `Interrupted` path exists to avoid.
    fn holds_toolbar(&self) -> bool {
        if self.launches_externally() {
            return false;
        }
        !self.focuses_main()
    }

    /// The URL this action should hand to the OS, if any.
    ///
    /// The single choke point for everything that reaches `tauri_plugin_opener`.
    /// The renderer's classifier already filtered these, but it is a UX filter,
    /// not a security boundary — a compromised or simply buggy overlay must not
    /// be able to route `file:///` or `javascript:` to the shell.
    fn open_target(&self, selection: &str) -> Option<String> {
        match self {
            SelectionToolbarAction::OpenLink { url } => {
                let parsed = url::Url::parse(url).ok()?;
                // Allowlist, not denylist: a scheme nobody anticipated is
                // refused rather than forwarded.
                matches!(parsed.scheme(), "http" | "https").then(|| parsed.to_string())
            }
            SelectionToolbarAction::ComposeEmail { address } => {
                // Built here rather than accepting a `mailto:` URI, so no part
                // of it is renderer-controlled beyond the address itself — and
                // an address carrying a header injection (`?bcc=`, newlines)
                // never survives the shape check.
                let trimmed = address.trim();
                let valid = !trimmed.is_empty()
                    && !trimmed.contains(char::is_whitespace)
                    && !trimmed.contains(['?', '&', '\n', '\r'])
                    && trimmed.matches('@').count() == 1
                    && trimmed.split('@').all(|part| !part.is_empty());
                valid.then(|| format!("mailto:{trimmed}"))
            }
            SelectionToolbarAction::SearchWeb { engine } => {
                let (_, base, param) = SEARCH_ENGINES.iter().find(|(id, _, _)| id == engine)?;
                let query = selection.trim();
                if query.is_empty() {
                    return None;
                }
                let mut url = url::Url::parse(base).ok()?;
                // Encoded by `url`, so a selection containing `&`, `#` or a
                // newline cannot restructure the request.
                url.query_pairs_mut().append_pair(param, query);
                Some(url.to_string())
            }
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionStagePayload {
    pub candidate: ExternalSelectionCandidate,
    pub action: SelectionToolbarAction,
    pub focus_main: bool,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SelectionToolbarStartArgs {
    #[serde(default)]
    pub disabled_apps: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionToolbarStatus {
    pub running: bool,
    pub has_candidate: bool,
}

struct ActiveSelectionMonitor {
    _subscription: InputSubscription,
    /// Dropping this unsubscribes from the in-process selection bus.
    _selection_subscription: SelectionSubscription,
    /// The automation-backend subscription, when the platform granted one.
    /// Must be released explicitly in `stop`: the monitor task is `abort`ed,
    /// so no async teardown inside it would ever run.
    event_subscription: Option<SubscriptionId>,
    task: tauri::async_runtime::JoinHandle<()>,
}

#[derive(Default)]
struct SelectionToolbarInner {
    active: Mutex<Option<ActiveSelectionMonitor>>,
    candidate: Mutex<Option<ExternalSelectionCandidate>>,
    pending_stage: Mutex<Option<SelectionStagePayload>>,
    disabled_apps: Mutex<HashSet<String>>,
    generation: AtomicU64,
    /// Every *opaque* rect inside the window, in logical (CSS) pixels, as last
    /// reported by the renderer: the capsule, plus the language list while it
    /// is open. The window is deliberately larger than its content (see
    /// `SHADOW_PAD`) and that surplus is transparent — so hit-testing the whole
    /// window would make the shadow margin a dead zone that neither activates a
    /// button nor dismisses.
    ///
    /// A list rather than one rect because the content is not one box: the
    /// language list is a *sibling* of the capsule with a gap between them.
    /// Hit-testing their bounding box would put that gap — and the two corners
    /// beside the narrower of the pair — back inside the toolbar.
    hit_rects: Mutex<Vec<Rect>>,
    /// Set while the pointer is over the capsule, or while an action is
    /// pending / speech is playing. Freezes the idle countdown.
    keep_alive: AtomicBool,
    idle_deadline: Mutex<Option<Instant>>,
    /// Set while the renderer has a focus-taking sub-panel open (the language
    /// list). Escape then belongs to that panel, not to the whole toolbar.
    interactive: AtomicBool,
    /// The action shortcut ids this module actually bound, so stopping releases
    /// exactly those and never a chord the user re-bound for themselves.
    owned_shortcuts: Mutex<HashSet<&'static str>>,
    /// Wall-clock ms of the last action chord `dispatch_shortcut` accepted.
    ///
    /// The input tap is listen-only and reports no modifier state, so the `3`
    /// of `⌥⇧3` is indistinguishable from a `3` typed into another app. A key
    /// press therefore does not dismiss on sight — it waits
    /// `SHORTCUT_CLAIM_GRACE_MS` and stands down if a chord claimed it.
    shortcut_claim_ms: AtomicI64,
}

#[derive(Clone, Default)]
pub struct SelectionToolbarState {
    inner: Arc<SelectionToolbarInner>,
}

impl SelectionToolbarState {
    fn is_running(&self) -> bool {
        self.inner.active.lock().is_some()
    }

    fn status(&self) -> SelectionToolbarStatus {
        SelectionToolbarStatus {
            running: self.is_running(),
            has_candidate: self.inner.candidate.lock().is_some(),
        }
    }
}

#[tauri::command]
pub async fn selection_toolbar_start(
    app: AppHandle,
    automation: State<'_, AutomationState>,
    state: State<'_, SelectionToolbarState>,
    args: Option<SelectionToolbarStartArgs>,
) -> Result<SelectionToolbarStatus, String> {
    let args = args.unwrap_or_default();
    *state.inner.disabled_apps.lock() = args
        .disabled_apps
        .into_iter()
        .map(|app| app.to_lowercase())
        .collect();
    if state.is_running() {
        return Ok(state.status());
    }

    // Build and convert the overlay up-front rather than lazily on the first
    // selection. `ensure_window` now waits for the AppKit thread (up to 5s), and
    // it used to be called from the monitor task — blocking a tokio worker for
    // that long. Doing it here also means a conversion failure surfaces as a
    // failed `start` the settings toggle can report, instead of as a toolbar
    // that quietly steals focus forever.
    {
        let app_handle = app.clone();
        tauri::async_runtime::spawn_blocking(move || ensure_window(&app_handle).map(|_| ()))
            .await
            .map_err(|error| format!("selection toolbar window setup panicked: {error}"))??;
    }

    let mut subscription = automation.input_monitor.subscribe(128)?;
    let mut receiver = subscription.take_receiver();
    // Ask the automation backend for selection notifications. On macOS this
    // starts the AXObserver thread; on Windows it registers the UIA 20014
    // handler. A backend that cannot do it (Linux, or macOS without the
    // Accessibility grant) simply leaves `selection_subscription` unused and
    // the click path carries the whole feature, exactly as before.
    let event_subscription = automation
        .handle
        .subscribe_events(EventFilter {
            kinds: Some(vec![
                EventKind::TextSelectionChanged,
                EventKind::FocusChanged,
            ]),
            scope: None,
        })
        .await
        .map_err(|error| log::debug!("selection toolbar: selection events unavailable: {error}"))
        .ok();
    let mut selection_subscription = selection_events::subscribe(64);
    let mut selection_receiver = selection_subscription.take_receiver();

    let coordinator = state.inner.clone();
    let automation_handle = automation.handle.clone();
    let app_handle = app.clone();
    let task = tauri::async_runtime::spawn(async move {
        // All of this is loop-local rather than shared state: exactly one task
        // reads and writes it, so there is nothing to synchronize.
        let mut press: Option<PressRecord> = None;
        let mut previous_release: Option<PressRecord> = None;
        let mut click_count: u32 = 0;
        let mut left_button_down = false;
        let mut settle = SettleState::default();
        // The in-flight selection read, so a superseding gesture can cancel it
        // rather than letting a stale answer race the fresh one.
        let mut pending_read: Option<tauri::async_runtime::JoinHandle<()>> = None;

        loop {
            tokio::select! {
                event = receiver.recv() => {
                    let Some(event) = event else { break };
                    match event {
                        InputEvent::MouseDown { x, y, button, ts_ms } => {
                            if button == InputButton::Left {
                                left_button_down = true;
                                press = Some(PressRecord { x, y, ts_ms });
                            }
                            if !point_inside_toolbar(&app_handle, &coordinator, x, y) {
                                dismiss(&app_handle, &coordinator, DismissReason::Interrupted);
                            }
                        }
                        InputEvent::MouseUp {
                            x,
                            y,
                            button: InputButton::Left,
                            ts_ms,
                        } => {
                            left_button_down = false;
                            let release = PressRecord { x, y, ts_ms };
                            let (intent, count) =
                                classify_release(press.take(), release, previous_release, click_count);
                            previous_release = Some(release);
                            click_count = count;

                            match resolve_trigger(intent, settle.deadline_ms.is_some()) {
                                // The observer already saw this gesture; its
                                // settle timer fires next tick now that the
                                // mid-drag interlock is released. Reading here
                                // too would duplicate the work.
                                Some(SelectionTrigger::AxObserver) => {}
                                Some(SelectionTrigger::Click) => {
                                    settle.deadline_ms = None;
                                    if let Some(handle) = pending_read.take() {
                                        handle.abort();
                                    }
                                    pending_read = Some(spawn_publish(
                                        &app_handle,
                                        &coordinator,
                                        &automation_handle,
                                        SelectionTrigger::Click,
                                        intent,
                                        Rect { x, y, width: 1, height: 1 },
                                    ));
                                }
                                // A plain click on an app that posts nothing.
                                // This is the common case, and it now costs
                                // nothing at all.
                                None => {}
                            }
                        }
                        InputEvent::Scroll { .. } => {
                            dismiss(&app_handle, &coordinator, DismissReason::Interrupted)
                        }
                        InputEvent::KeyDown { vk, ts_ms } => {
                            handle_key_down(
                                &app_handle,
                                &coordinator,
                                vk,
                                ts_ms,
                                settle.deadline_ms.is_some(),
                            );
                        }
                        _ => {}
                    }
                }

                signal = selection_receiver.recv() => {
                    let Some(signal) = signal else { continue };
                    match settle_decision(signal.selected_len, signal.at_ms) {
                        SettleAction::DismissNow => {
                            settle.deadline_ms = None;
                            dismiss(&app_handle, &coordinator, DismissReason::Interrupted);
                        }
                        SettleAction::Ignore => settle.deadline_ms = None,
                        // Re-arming pushes the deadline out, so a burst of
                        // keystrokes collapses into a single publish once the
                        // user stops moving the caret.
                        SettleAction::Arm { deadline_ms } => settle.deadline_ms = Some(deadline_ms),
                    }
                }

                _ = settle_sleep(settle.deadline_ms) => {
                    settle.deadline_ms = None;
                    // Mid-drag the selection is still changing under the
                    // cursor; the mouse-up will publish it. Firing here would
                    // pop the capsule out from under the moving pointer.
                    if left_button_down {
                        continue;
                    }
                    if let Some(handle) = pending_read.take() {
                        handle.abort();
                    }
                    pending_read = Some(spawn_publish(
                        &app_handle,
                        &coordinator,
                        &automation_handle,
                        SelectionTrigger::AxObserver,
                        ClickIntent::Ignore,
                        Rect { x: 0, y: 0, width: 1, height: 1 },
                    ));
                }
            }
        }
    });

    *state.inner.active.lock() = Some(ActiveSelectionMonitor {
        _subscription: subscription,
        _selection_subscription: selection_subscription,
        event_subscription,
        task,
    });
    bind_action_shortcuts(&app, &state.inner);
    Ok(state.status())
}

/// Sleep until the settle deadline, or forever when nothing is armed.
///
/// `tokio::select!` polls every branch each iteration, so the disarmed case
/// needs a future that simply never completes rather than one that returns
/// immediately and spins the loop.
async fn settle_sleep(deadline_ms: Option<i64>) {
    let Some(deadline_ms) = deadline_ms else {
        std::future::pending::<()>().await;
        return;
    };
    let remaining = deadline_ms.saturating_sub(now_ms()).max(0) as u64;
    tokio::time::sleep(Duration::from_millis(remaining)).await;
}

/// The single funnel both layers publish through.
///
/// Ordering matters and is the point of the whole phase: the preflight runs
/// *before* the selection read, so a disabled app or a password field costs one
/// cheap AX probe instead of a full selection round-trip (and, on macOS, an
/// `osascript` fork).
fn spawn_publish<R: Runtime>(
    app: &AppHandle<R>,
    inner: &Arc<SelectionToolbarInner>,
    automation: &crate::automation::worker::AutomationHandle,
    trigger: SelectionTrigger,
    intent: ClickIntent,
    cursor_anchor: Rect,
) -> tauri::async_runtime::JoinHandle<()> {
    let app = app.clone();
    let inner = inner.clone();
    let automation = automation.clone();
    tauri::async_runtime::spawn(async move {
        // The observer path has already waited out the settle window, so only
        // the click path needs to let the app commit its selection first.
        if trigger == SelectionTrigger::Click {
            tokio::time::sleep(Duration::from_millis(60)).await;
        }

        let preflight = automation.selection_preflight().await.ok();
        if let Some(preflight) = preflight.as_ref() {
            if preflight.secure_field {
                return;
            }
            if let Some(name) = preflight.process_name.as_deref() {
                if app_is_disabled(&inner, name) {
                    return;
                }
            }
        }

        let mut snapshot = read_accessibility_selection(&automation).await;
        if snapshot.is_none() && trigger == SelectionTrigger::Click {
            tokio::time::sleep(Duration::from_millis(120)).await;
            snapshot = read_accessibility_selection(&automation).await;
        }

        let Some(mut snapshot) = snapshot else {
            // AX told us nothing. In an image, a PDF viewer, a Java app or a
            // remote desktop that is not a failure — there simply is no
            // accessible text — so read the pixels instead.
            if let Some(candidate) = ocr_fallback(&app, &inner, intent, preflight.as_ref()).await {
                let _ = show_candidate(&app, &inner, candidate);
            }
            return;
        };
        if app_is_disabled(&inner, &snapshot.source_app) {
            return;
        }
        // Windows reports no length in the notification, so the auto-raise
        // bound has to be re-checked here, once the real text is in hand.
        if snapshot.text.chars().count() as i64 > SELECTION_MAX_AUTO_RAISE_CHARS {
            return;
        }
        if inner
            .candidate
            .lock()
            .as_ref()
            .is_some_and(|current| is_same_selection(current, &snapshot))
        {
            return;
        }
        if snapshot.anchor_rect.is_none() {
            snapshot.anchor_rect = Some(cursor_anchor);
        }
        // `secure_field` is the only subrole the renderer acts on, and the
        // preflight already resolved it — no second hit-test needed for the
        // overwhelmingly common case.
        let subrole = preflight
            .as_ref()
            .and_then(|p| p.secure_field.then(|| "AXSecureTextField".to_string()));
        let source_url = preflight
            .as_ref()
            .and_then(|p| trim_source_url(p.source_url.as_deref()));
        let candidate =
            ExternalSelectionCandidate::from_snapshot(snapshot, SelectionOrigin::Accessibility)
                .with_source_element(subrole, source_url);
        let _ = show_candidate(&app, &inner, candidate);
    })
}

/// Reduce a page URL to `scheme://host/path`.
///
/// The query string, fragment and userinfo are dropped before the URL leaves
/// Rust. This is the likeliest PII leak on the whole path — session tokens,
/// search terms and email addresses live in query parameters, and the redaction
/// gate downstream only recognizes the `user:pass@host` shape. Dropping them
/// here means the model still learns *which page* the text came from without
/// any of that riding along.
fn trim_source_url(raw: Option<&str>) -> Option<String> {
    let mut parsed = url::Url::parse(raw?).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }
    parsed.set_query(None);
    parsed.set_fragment(None);
    let _ = parsed.set_username("");
    let _ = parsed.set_password(None);
    Some(parsed.to_string())
}

/// Smallest drag box worth capturing, in logical pixels. Below this the region
/// cannot hold legible text and OCR would only ever return noise.
const OCR_MIN_REGION_PX: i32 = 16;
/// Breathing room around the drag box, so glyphs clipped by the exact
/// selection rectangle (descenders, italics, the last character) still land in
/// the captured image.
const OCR_REGION_PAD: i32 = 6;

/// Whether every condition for reading the screen is met.
///
/// Pure and all-or-nothing on purpose: this decides whether Cognia takes a
/// picture of the user's screen, so the conditions belong in one place where
/// they can be read — and tested — as a single sentence.
fn ocr_fallback_allowed(
    intent: ClickIntent,
    app_disabled: bool,
    secure_field: bool,
    capture_permitted: bool,
    backend_available: bool,
) -> bool {
    if app_disabled || secure_field || !capture_permitted || !backend_available {
        return false;
    }
    // Only a real drag. A click or a double-click gives no region to capture,
    // and guessing one would mean screenshotting a rectangle the user never
    // indicated.
    matches!(
        intent,
        ClickIntent::Drag { bounds }
            if bounds.width >= OCR_MIN_REGION_PX && bounds.height >= OCR_MIN_REGION_PX
    )
}

/// Grow a rect by `pad` on every side.
fn pad_rect(rect: Rect, pad: i32) -> Rect {
    Rect {
        x: rect.x - pad,
        y: rect.y - pad,
        width: rect.width + pad * 2,
        height: rect.height + pad * 2,
    }
}

/// Read the selected text off the screen when the accessibility API has none.
///
/// Returns `None` — silently — whenever any gate fails. In particular, a
/// missing Screen Recording grant must NOT fall through to a capture: macOS
/// answers that with a picture of the desktop minus every window's contents,
/// so OCR would confidently return the user's wallpaper text and this function
/// would hand it back as "your selection".
async fn ocr_fallback<R: Runtime>(
    app: &AppHandle<R>,
    inner: &Arc<SelectionToolbarInner>,
    intent: ClickIntent,
    preflight: Option<&crate::automation::backend::SelectionPreflight>,
) -> Option<ExternalSelectionCandidate> {
    let source_app = preflight
        .and_then(|p| p.process_name.as_deref())
        .unwrap_or("Screen");
    let registry = app.state::<cognia_ocr::NativeOcrRegistry>();
    let available = registry.available_ids().await;
    let backend = available
        .iter()
        .find(|id| **id == "apple-vision")
        .or_else(|| available.first())
        .copied();

    if !ocr_fallback_allowed(
        intent,
        app_is_disabled(inner, source_app),
        preflight.is_some_and(|p| p.secure_field),
        crate::automation::platform::shared::screen_capture::screen_capture_permitted(),
        backend.is_some(),
    ) {
        return None;
    }
    let (ClickIntent::Drag { bounds }, Some(backend)) = (intent, backend) else {
        return None;
    };

    let region = pad_rect(bounds, OCR_REGION_PAD);
    let shot = tokio::task::spawn_blocking(move || {
        crate::automation::platform::shared::screenshot::capture_global_region(
            region,
            crate::automation::types::ImageFormat::Png,
        )
    })
    .await
    .ok()?
    .map_err(|error| log::debug!("selection toolbar: OCR capture failed: {error}"))
    .ok()?;

    // `Screenshot.bytes` is base64; the OCR payload wants raw bytes.
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&shot.bytes)
        .map_err(|error| log::debug!("selection toolbar: OCR payload decode failed: {error}"))
        .ok()?;

    let result = registry
        .dispatch(&cognia_ocr::NativeOcrInvokePayload {
            backend: backend.to_string(),
            bytes,
            mime_type: "image/png".to_string(),
            languages: vec![],
        })
        .await
        .map_err(|error| log::debug!("selection toolbar: OCR failed: {error}"))
        .ok()?;

    let snapshot = build_text_selection(
        &result.text,
        source_app,
        preflight.and_then(|p| p.window_title.as_deref()),
        Some(bounds),
    )?;
    Some(ExternalSelectionCandidate::from_snapshot(
        snapshot,
        SelectionOrigin::Ocr,
    ))
}

/// Key handling, extracted so the monitor loop stays readable.
fn handle_key_down<R: Runtime>(
    app: &AppHandle<R>,
    inner: &Arc<SelectionToolbarInner>,
    vk: u32,
    ts_ms: i64,
    settle_armed: bool,
) {
    let window = app.get_webview_window(SELECTION_TOOLBAR_LABEL);
    let toolbar_focused = window
        .as_ref()
        .and_then(|window| window.is_focused().ok())
        .unwrap_or(false);
    if is_escape_key(vk) {
        // With the language list open the toolbar holds focus, so give the
        // renderer the first refusal: Escape should close that panel, and only
        // a second Escape (by which point `interactive` is false again) the
        // toolbar.
        if inner.interactive.load(Ordering::SeqCst) {
            if let Some(window) = window.as_ref() {
                let _ = window.emit(SELECTION_ESCAPE_EVENT, ());
            }
        } else {
            dismiss(app, inner, DismissReason::Interrupted);
        }
        return;
    }
    if is_modifier_key(vk) {
        // Holding ⌥⇧ is the start of an action chord, never a sign the user
        // has moved on.
        return;
    }
    if is_selection_navigation_key(vk, settle_armed) {
        // These keys are how a keyboard user *builds* the selection we are
        // waiting to show. Treating them as "moved on" made the keyboard path
        // cancel itself on the very keystroke that armed it.
        return;
    }
    if toolbar_focused {
        return;
    }
    // Typing anywhere else means the user has moved on — but only once the
    // action chords have had their say. See `shortcut_claim_ms`: the tap cannot
    // see modifiers, so dismissing here on sight nulled the candidate before
    // `dispatch_shortcut` could read it, and every ⌥⇧1–⌥⇧6 press cancelled
    // itself.
    let inner = inner.clone();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(SHORTCUT_CLAIM_GRACE_MS)).await;
        if key_press_was_claimed(&inner, ts_ms) {
            return;
        }
        dismiss(&app, &inner, DismissReason::Interrupted);
    });
}

#[tauri::command]
pub async fn selection_toolbar_stop(
    app: AppHandle,
    automation: State<'_, AutomationState>,
    state: State<'_, SelectionToolbarState>,
) -> Result<SelectionToolbarStatus, String> {
    // Take the monitor out under the lock, then do the async teardown outside
    // it — a parking_lot guard must never be held across an `.await`.
    let active = state.inner.active.lock().take();
    if let Some(mut active) = active {
        active.task.abort();
        // Explicit, and the only place it can happen: the task was just
        // aborted, so nothing inside it will ever run a `Drop`-based release.
        // Leaving this out would strand the AXObserver thread for the rest of
        // the session every time the feature is toggled off.
        if let Some(id) = active.event_subscription.take() {
            if let Err(error) = automation.handle.unsubscribe(id).await {
                log::debug!("selection toolbar: releasing selection events failed: {error}");
            }
        }
        drop(active);
    }
    unbind_action_shortcuts(&app, &state.inner);
    dismiss(&app, &state.inner, DismissReason::Interrupted);
    automation.input_monitor.stop_if_idle();
    Ok(state.status())
}

/// Claim the six action chords, recording which ones we actually took.
///
/// A chord the user has already re-bound (the renderer replays persisted
/// overrides at boot) is left alone — binding the default here would silently
/// clobber their configuration. A conflict with an unrelated shortcut is logged
/// and skipped rather than failing `start`: losing one hotkey is not a reason to
/// leave the whole feature off.
///
/// The ids that *were* claimed go into `owned_shortcuts`, because ownership is
/// the only thing that makes the unbind safe — see `unbind_action_shortcuts`.
fn bind_action_shortcuts<R: Runtime>(app: &AppHandle<R>, inner: &Arc<SelectionToolbarInner>) {
    let registry = app.state::<Arc<crate::shortcuts::ShortcutRegistry>>();
    claim_shortcuts(
        &mut inner.owned_shortcuts.lock(),
        |id| registry.chord_for_id(id).is_some(),
        |id, chord| registry.bind(app, id, chord),
    );
}

/// Registry-free half of `bind_action_shortcuts`, so the ownership rule can be
/// tested without a live Tauri app.
fn claim_shortcuts<E: std::fmt::Display>(
    owned: &mut HashSet<&'static str>,
    already_bound: impl Fn(&str) -> bool,
    mut bind: impl FnMut(&str, &str) -> Result<(), E>,
) {
    for (id, chord) in SELECTION_ACTION_SHORTCUTS {
        if already_bound(id) {
            continue;
        }
        match bind(id, chord) {
            Ok(()) => {
                owned.insert(*id);
            }
            Err(error) => {
                log::warn!("selection toolbar shortcut {id}={chord} not bound: {error}")
            }
        }
    }
}

/// Release only the chords `bind_action_shortcuts` actually claimed.
///
/// Unbinding all six unconditionally is destructive, not merely untidy:
/// `ShortcutRegistry::unbind` drops the id → chord mapping and unregisters it
/// with the OS, so turning the toolbar off would delete a chord the user had
/// re-bound to something else — one this module deliberately never took. Bind
/// and unbind have to agree on ownership, so they share `owned_shortcuts`.
fn unbind_action_shortcuts<R: Runtime>(app: &AppHandle<R>, inner: &Arc<SelectionToolbarInner>) {
    let registry = app.state::<Arc<crate::shortcuts::ShortcutRegistry>>();
    release_shortcuts(&mut inner.owned_shortcuts.lock(), |id| {
        registry.unbind(app, id)
    });
}

/// Registry-free half of `unbind_action_shortcuts`.
fn release_shortcuts<E: std::fmt::Display>(
    owned: &mut HashSet<&'static str>,
    mut unbind: impl FnMut(&str) -> Result<(), E>,
) {
    for id in std::mem::take(owned) {
        if let Err(error) = unbind(id) {
            log::warn!("selection toolbar shortcut {id} not released: {error}");
        }
    }
}

/// Record that an action chord fired at `at_ms`, so the raw key press that
/// produced it stands down instead of dismissing.
fn claim_key_press(inner: &SelectionToolbarInner, at_ms: i64) {
    inner.shortcut_claim_ms.store(at_ms, Ordering::SeqCst);
}

/// Whether a key press seen at `pressed_ms` has since been claimed by a chord.
///
/// The input tap is listen-only and reports no modifier state, so the `3` of
/// `⌥⇧3` is indistinguishable from a `3` typed into another app. The press
/// therefore waits `SHORTCUT_CLAIM_GRACE_MS` and asks this before dismissing.
fn key_press_was_claimed(inner: &SelectionToolbarInner, pressed_ms: i64) -> bool {
    inner.shortcut_claim_ms.load(Ordering::SeqCst) >= pressed_ms
}

/// Forward a global chord to the toolbar renderer as if the matching button
/// had been clicked. A no-op when nothing is on offer — the chords stay
/// registered for as long as the feature runs, so most presses land here.
///
/// Deliberately a *notification* rather than a second execution path: the
/// renderer owns the translation target the user picked, the pending/✓/⚠
/// state machine, and the exit animation. Running the action from Rust would
/// fork all three and drift from the click path.
pub fn dispatch_shortcut<R: Runtime>(app: &AppHandle<R>, id: &str) {
    if !SELECTION_ACTION_SHORTCUTS
        .iter()
        .any(|(known, _)| *known == id)
    {
        return;
    }
    let state = app.state::<SelectionToolbarState>();
    // Claim before anything can bail: the raw key press that produced this
    // chord is already sitting in its grace window, and it must stand down even
    // if the candidate went away in between.
    claim_key_press(&state.inner, now_ms());
    let Some(candidate) = state.inner.candidate.lock().clone() else {
        return;
    };
    let Some(window) = app.get_webview_window(SELECTION_TOOLBAR_LABEL) else {
        return;
    };
    let _ = window.emit(
        SELECTION_SHORTCUT_EVENT,
        serde_json::json!({ "shortcutId": id, "candidateId": candidate.id }),
    );
}

#[tauri::command]
pub async fn selection_toolbar_status(
    state: State<'_, SelectionToolbarState>,
) -> Result<SelectionToolbarStatus, String> {
    Ok(state.status())
}

#[tauri::command]
pub async fn selection_toolbar_current_candidate(
    state: State<'_, SelectionToolbarState>,
) -> Result<Option<ExternalSelectionCandidate>, String> {
    Ok(state.inner.candidate.lock().clone())
}

#[tauri::command]
pub async fn selection_toolbar_capture_clipboard(
    app: AppHandle,
) -> Result<Option<ExternalSelectionCandidate>, String> {
    capture_clipboard_candidate(&app).await
}

#[tauri::command]
pub async fn selection_toolbar_execute(
    app: AppHandle,
    state: State<'_, SelectionToolbarState>,
    candidate_id: String,
    action: SelectionToolbarAction,
) -> Result<(), String> {
    let candidate = state
        .inner
        .candidate
        .lock()
        .clone()
        .filter(|candidate| candidate.id == candidate_id)
        .ok_or_else(|| "selection candidate is stale".to_string())?;

    let holds_toolbar = action.holds_toolbar();
    match action {
        SelectionToolbarAction::Copy => {
            app.clipboard()
                .write_text(candidate.text.clone())
                .map_err(|error| error.to_string())?;
        }
        // Hands off to the browser or the mail client. `open_target` re-parses
        // and refuses anything but http(s)/mailto it built itself, so a bad
        // payload fails loudly here rather than reaching the shell.
        ref action if action.launches_externally() => {
            let target = action
                .open_target(&candidate.text)
                .ok_or_else(|| "selection action carried an unusable target".to_string())?;
            tauri_plugin_opener::OpenerExt::opener(&app)
                .open_url(target, None::<&str>)
                .map_err(|error| error.to_string())?;
        }
        action => {
            let Some(main) = app.get_webview_window("main") else {
                return Err("main window is unavailable".into());
            };
            let focus_main = action.focuses_main();
            let payload = SelectionStagePayload {
                candidate,
                action,
                focus_main,
            };
            *state.inner.pending_stage.lock() = Some(payload.clone());
            if focus_main {
                crate::window_utils::bring_window_to_front(&main);
            }
            main.emit(SELECTION_STAGE_EVENT, payload)
                .map_err(|error| error.to_string())?;
        }
    }
    if holds_toolbar {
        // The renderer closes these out through `selection_toolbar_finish`.
        // Hold the toolbar open meanwhile so the idle watchdog cannot pull it
        // out from under a checkmark, a spinner or a playing waveform.
        state.inner.keep_alive.store(true, Ordering::SeqCst);
    } else {
        dismiss(&app, &state.inner, DismissReason::Completed);
    }
    Ok(())
}

/// Called by the toolbar renderer once a `holds_toolbar` action has settled
/// (checkmark shown, memory written or PII-blocked, speech finished/stopped).
#[tauri::command]
pub async fn selection_toolbar_finish(
    app: AppHandle,
    state: State<'_, SelectionToolbarState>,
    candidate_id: String,
) -> Result<(), String> {
    let matches_current = state
        .inner
        .candidate
        .lock()
        .as_ref()
        .is_some_and(|candidate| candidate.id == candidate_id);
    if matches_current {
        dismiss(&app, &state.inner, DismissReason::Completed);
    }
    Ok(())
}

/// Freeze or resume the idle countdown. Driven by pointer enter/leave on the
/// capsule and by the renderer's pending / speaking states.
#[tauri::command]
pub async fn selection_toolbar_set_keep_alive(
    state: State<'_, SelectionToolbarState>,
    window: WebviewWindow,
    keep_alive: bool,
) -> Result<(), String> {
    if window.label() != SELECTION_TOOLBAR_LABEL {
        return Err("selection toolbar keep-alive called from wrong window".into());
    }
    state.inner.keep_alive.store(keep_alive, Ordering::SeqCst);
    if !keep_alive {
        *state.inner.idle_deadline.lock() =
            Some(Instant::now() + Duration::from_millis(IDLE_DISMISS_MS));
    }
    Ok(())
}

/// Size the native window to the renderer's measured content and re-anchor it.
///
/// `width`/`height` are the full window box in logical pixels — the content
/// plus its `SHADOW_PAD` margin — and `hit_rects` are the opaque rects inside
/// that box (the capsule, plus the language list when it is open), which is
/// what hit-testing must use. Returns the placement actually chosen, because a
/// taller measured toolbar can no longer fit above a selection that the
/// placeholder size did fit above.
#[tauri::command]
pub async fn selection_toolbar_resize(
    app: AppHandle,
    state: State<'_, SelectionToolbarState>,
    window: WebviewWindow,
    width: f64,
    height: f64,
    hit_rects: Vec<Rect>,
) -> Result<SelectionToolbarGeometry, String> {
    if window.label() != SELECTION_TOOLBAR_LABEL {
        return Err("selection toolbar resize called from wrong window".into());
    }
    let width = width.max(MIN_TOOLBAR_WIDTH);
    let height = height.max(MIN_TOOLBAR_HEIGHT);
    *state.inner.hit_rects.lock() = hit_rects;

    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|error| error.to_string())?;

    let anchor = state
        .inner
        .candidate
        .lock()
        .as_ref()
        .and_then(|candidate| candidate.anchor_rect);
    let Some(anchor) = anchor else {
        return Ok(SelectionToolbarGeometry {
            placement: ToolbarPlacement::Above,
        });
    };
    let (x, y, placement) = toolbar_position(&app, anchor, width as i32, height as i32);
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|error| error.to_string())?;
    Ok(SelectionToolbarGeometry { placement })
}

#[tauri::command]
pub async fn selection_toolbar_take_pending_stage(
    state: State<'_, SelectionToolbarState>,
) -> Result<Option<SelectionStagePayload>, String> {
    Ok(state.inner.pending_stage.lock().take())
}

#[tauri::command]
pub async fn selection_toolbar_reveal(window: WebviewWindow) -> Result<(), String> {
    if window.label() != SELECTION_TOOLBAR_LABEL {
        return Err("selection toolbar reveal called from wrong window".into());
    }
    reveal_toolbar_window(&window)
}

/// Reveal without focus.
///
/// On macOS this must go through the panel rather than `WebviewWindow::show`:
/// the generation check inside `reveal_overlay_panel` is what lets a dismiss
/// that lands while a reveal is queued actually cancel it. `focus: false`
/// because merely *appearing* must never take the keyboard away from the
/// document the user selected text in — only opening the language list does
/// that, via `selection_toolbar_set_interactive`.
fn reveal_toolbar_window<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let role = crate::pet_window::OverlayPanelRole::SelectionToolbar;
        let generation = crate::pet_window::current_overlay_panel_generation(role);
        crate::pet_window::reveal_overlay_panel(window, role, false, generation)
    }
    #[cfg(not(target_os = "macos"))]
    window.show().map_err(|error| error.to_string())
}

/// Toggle the toolbar's ability to take focus, so an open dropdown can receive
/// keyboard input.
///
/// It used to also jump the window to a fixed 280px "menu height" and re-anchor
/// it for that height, which teleported the capsule ~236px up the screen the
/// moment the language menu opened. Sizing is now entirely renderer-driven via
/// `selection_toolbar_resize`: the window grows *downward* around a capsule
/// that does not move.
#[tauri::command]
pub async fn selection_toolbar_set_interactive(
    state: State<'_, SelectionToolbarState>,
    window: WebviewWindow,
    interactive: bool,
) -> Result<(), String> {
    if window.label() != SELECTION_TOOLBAR_LABEL {
        return Err("selection toolbar focus called from wrong window".into());
    }
    state.inner.interactive.store(interactive, Ordering::SeqCst);
    #[cfg(target_os = "windows")]
    {
        // Clearing `WS_EX_NOACTIVATE` is what lets the window accept the
        // keyboard at all, so the `set_focus` below is still required here.
        set_windows_interactive(&window, interactive)?;
        if interactive {
            window.set_focus().map_err(|error| error.to_string())?;
        }
    }
    // macOS: NEVER `set_focus`. Tauri routes it through tao, which calls
    // `NSApp.activateIgnoringOtherApps` — the source application deactivates,
    // its selection highlight greys out, and the user's keystrokes stop
    // reaching the document they just selected text in. The non-activating
    // panel takes the keyboard without any of that.
    //
    // Resigning on the false edge matters just as much: a toolbar that stays
    // key after the language list closes keeps swallowing arrow keys that
    // belong to the user's app.
    #[cfg(target_os = "macos")]
    crate::pet_window::set_overlay_panel_key(&window, interactive)?;
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    if interactive {
        window.set_focus().map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn spawn_clipboard_capture<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = capture_clipboard_candidate(&app).await {
            log::warn!("selection toolbar clipboard capture failed: {error}");
        }
    });
}

async fn capture_clipboard_candidate<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<Option<ExternalSelectionCandidate>, String> {
    let state = app.state::<SelectionToolbarState>();
    if !state.is_running() {
        return Ok(None);
    }
    let text = app
        .clipboard()
        .read_text()
        .map_err(|error| error.to_string())?;
    let automation = app.state::<AutomationState>();
    let focus = automation.handle.get_focus().await.ok();
    let cursor = automation
        .handle
        .cursor_position()
        .await
        .unwrap_or(Point { x: 0, y: 0 });
    let source_app = focus
        .as_ref()
        .and_then(|focus| focus.process_name.as_deref())
        .unwrap_or("Clipboard");
    if app_is_disabled(&state.inner, source_app) {
        return Ok(None);
    }
    let snapshot = build_text_selection(
        &text,
        source_app,
        focus
            .as_ref()
            .and_then(|focus| focus.window_title.as_deref()),
        Some(Rect {
            x: cursor.x,
            y: cursor.y,
            width: 1,
            height: 1,
        }),
    );
    let Some(snapshot) = snapshot else {
        return Ok(None);
    };
    let candidate = ExternalSelectionCandidate::from_snapshot(snapshot, SelectionOrigin::Clipboard);
    show_candidate(app, &state.inner, candidate.clone())?;
    Ok(Some(candidate))
}

async fn read_accessibility_selection(
    automation: &crate::automation::worker::AutomationHandle,
) -> Option<TextSelectionSnapshot> {
    if credential_window::is_credential_window_focused() {
        return None;
    }
    automation.read_text_selection().await.ok().flatten()
}

fn app_is_disabled(inner: &SelectionToolbarInner, source_app: &str) -> bool {
    let normalized = source_app.to_lowercase();
    is_default_blocked_app(&normalized) || inner.disabled_apps.lock().contains(&normalized)
}

fn is_default_blocked_app(normalized_app: &str) -> bool {
    DEFAULT_BLOCKED_APPS
        .iter()
        .any(|blocked| normalized_app.contains(blocked))
}

/// `InputEvent::KeyDown` carries a Windows-style virtual-key code on every
/// platform — the macOS tap runs its raw CGKeyCode through
/// `cg_keycode_to_vk` before publishing — so one constant covers both.
const VK_ESCAPE: u32 = 0x1B;

fn is_escape_key(vk: u32) -> bool {
    vk == VK_ESCAPE
}

/// Same clock the input monitor stamps `InputEvent::ts_ms` with, so a shortcut
/// claim is directly comparable against the key press that produced it.
fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Modifier keys, which start a chord rather than ending the selection.
///
/// Only Windows' low-level keyboard hook reports these: the macOS tap
/// subscribes to `KeyDown` and not `FlagsChanged`, so a bare ⌥ or ⇧ never
/// reaches us there. Without this, holding ⌥⇧ to press an action chord
/// dismissed the toolbar on the very first modifier.
fn is_modifier_key(vk: u32) -> bool {
    const VK_SHIFT: u32 = 0x10;
    const VK_CONTROL: u32 = 0x11;
    const VK_MENU: u32 = 0x12;
    const VK_LWIN: u32 = 0x5B;
    const VK_RWIN: u32 = 0x5C;
    const VK_LSHIFT: u32 = 0xA0;
    const VK_RSHIFT: u32 = 0xA1;
    const VK_LCONTROL: u32 = 0xA2;
    const VK_RCONTROL: u32 = 0xA3;
    const VK_LMENU: u32 = 0xA4;
    const VK_RMENU: u32 = 0xA5;
    matches!(
        vk,
        VK_SHIFT
            | VK_CONTROL
            | VK_MENU
            | VK_LWIN
            | VK_RWIN
            | VK_LSHIFT
            | VK_RSHIFT
            | VK_LCONTROL
            | VK_RCONTROL
            | VK_LMENU
            | VK_RMENU
    )
}

/// Keys that *build* a selection rather than ending one.
///
/// Without this the keyboard path is broken by construction: ⇧→ and ⇧↓ are the
/// very keystrokes that create the selection, and they arrive as `KeyDown`
/// events that land in the "the user has moved on" branch — so the toolbar
/// would dismiss itself the instant it was armed. `A` is included while a
/// settle is pending because ⌘A / ^A is select-all; outside that window it is
/// an ordinary letter and must still dismiss.
fn is_selection_navigation_key(vk: u32, settle_armed: bool) -> bool {
    const VK_PRIOR: u32 = 0x21; // Page Up
    const VK_NEXT: u32 = 0x22; // Page Down
    const VK_END: u32 = 0x23;
    const VK_HOME: u32 = 0x24;
    const VK_LEFT: u32 = 0x25;
    const VK_UP: u32 = 0x26;
    const VK_RIGHT: u32 = 0x27;
    const VK_DOWN: u32 = 0x28;
    const VK_A: u32 = 0x41;
    matches!(
        vk,
        VK_PRIOR | VK_NEXT | VK_END | VK_HOME | VK_LEFT | VK_UP | VK_RIGHT | VK_DOWN
    ) || (settle_armed && vk == VK_A)
}

/// Whether a freshly-read snapshot is the selection already on screen.
///
/// Belt to the interlock's braces: the observer and the click path can both
/// legitimately fire for one user gesture, and re-publishing would restart the
/// enter animation and the idle countdown for no reason.
fn is_same_selection(
    current: &ExternalSelectionCandidate,
    snapshot: &TextSelectionSnapshot,
) -> bool {
    current.text == snapshot.text && current.source_app == snapshot.source_app
}

fn show_candidate<R: Runtime>(
    app: &AppHandle<R>,
    inner: &Arc<SelectionToolbarInner>,
    candidate: ExternalSelectionCandidate,
) -> Result<(), String> {
    let anchor = candidate.anchor_rect.unwrap_or(Rect {
        x: 0,
        y: 0,
        width: 1,
        height: 1,
    });
    let window = ensure_window(app)?;
    // Claim a reveal lifecycle. Everything queued for an older candidate is
    // invalidated by the bumped generation, so a `reveal` still in flight when
    // this candidate arrives cannot show the previous one's geometry.
    #[cfg(target_os = "macos")]
    crate::pet_window::begin_overlay_panel_open(
        crate::pet_window::OverlayPanelRole::SelectionToolbar,
    );
    // Placeholder placement only. The window is still hidden: the renderer
    // measures the capsule, calls `selection_toolbar_resize` (which re-anchors
    // against the real size) and only then reveals.
    let (x, y, _) = toolbar_position(
        app,
        anchor,
        MIN_TOOLBAR_WIDTH as i32,
        MIN_TOOLBAR_HEIGHT as i32,
    );
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|error| error.to_string())?;
    *inner.candidate.lock() = Some(candidate.clone());
    inner.hit_rects.lock().clear();
    inner.keep_alive.store(false, Ordering::SeqCst);
    *inner.idle_deadline.lock() = Some(Instant::now() + Duration::from_millis(IDLE_DISMISS_MS));
    window
        .emit(SELECTION_CANDIDATE_EVENT, candidate.clone())
        .map_err(|error| error.to_string())?;

    spawn_idle_watchdog(app, inner, candidate.id);
    Ok(())
}

/// Idle countdown for one candidate.
///
/// This replaced a single `sleep(IDLE_DISMISS_MS)`, which could not be called
/// off — so the toolbar vanished mid-read even with the pointer resting on it.
/// Ticking lets `keep_alive` (pointer hover, a pending action, playing speech)
/// keep pushing the deadline out.
fn spawn_idle_watchdog<R: Runtime>(
    app: &AppHandle<R>,
    inner: &Arc<SelectionToolbarInner>,
    candidate_id: String,
) {
    let app = app.clone();
    let inner = inner.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(IDLE_TICK_MS)).await;
            let still_current = inner
                .candidate
                .lock()
                .as_ref()
                .is_some_and(|current| current.id == candidate_id);
            if !still_current {
                return;
            }
            if inner.keep_alive.load(Ordering::SeqCst) {
                *inner.idle_deadline.lock() =
                    Some(Instant::now() + Duration::from_millis(IDLE_DISMISS_MS));
                continue;
            }
            if idle_deadline_passed(&inner, Instant::now()) {
                dismiss(&app, &inner, DismissReason::Idle);
                return;
            }
        }
    });
}

fn idle_deadline_passed(inner: &SelectionToolbarInner, now: Instant) -> bool {
    inner
        .idle_deadline
        .lock()
        .is_some_and(|deadline| now >= deadline)
}

fn ensure_window<R: Runtime>(app: &AppHandle<R>) -> Result<WebviewWindow<R>, String> {
    if let Some(window) = app.get_webview_window(SELECTION_TOOLBAR_LABEL) {
        return Ok(window);
    }
    let window = WebviewWindowBuilder::new(
        app,
        SELECTION_TOOLBAR_LABEL,
        WebviewUrl::App("selection-toolbar".into()),
    )
    .transparent(true)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .shadow(false)
    .visible(false)
    .inner_size(MIN_TOOLBAR_WIDTH, MIN_TOOLBAR_HEIGHT)
    .build()
    .map_err(|error| error.to_string())?;
    let _ = window.remove_menu();

    // AWAITED, and fail-closed. `run_on_main_thread` only *enqueues*, so the
    // conversion could lose a race against the first `reveal` and briefly put
    // an ordinary — activating — NSWindow on screen; and because the old code
    // only logged a warning, a failed conversion left the toolbar running as a
    // focus-stealing normal window for the rest of the session. Closing the
    // window and returning the error means `selection_toolbar_start` reports
    // the failure instead of silently degrading.
    #[cfg(target_os = "macos")]
    if let Err(error) = crate::pet_window::configure_overlay_panel(
        &window,
        crate::pet_window::OverlayPanelRole::SelectionToolbar,
    ) {
        let _ = window.close();
        return Err(format!("selection toolbar NSPanel setup failed: {error}"));
    }
    #[cfg(target_os = "windows")]
    apply_windows_no_activate(&window)?;

    Ok(window)
}

#[cfg(target_os = "windows")]
fn apply_windows_no_activate(window: &WebviewWindow) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongW, SetWindowLongW, GWL_EXSTYLE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    };
    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    let current = unsafe { GetWindowLongW(hwnd, GWL_EXSTYLE) };
    let next = current | WS_EX_NOACTIVATE.0 as i32 | WS_EX_TOOLWINDOW.0 as i32;
    unsafe {
        SetWindowLongW(hwnd, GWL_EXSTYLE, next);
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn set_windows_interactive(window: &WebviewWindow, interactive: bool) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongW, SetWindowLongW, GWL_EXSTYLE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    };
    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    let current = unsafe { GetWindowLongW(hwnd, GWL_EXSTYLE) };
    let next = if interactive {
        current & !(WS_EX_NOACTIVATE.0 as i32) | WS_EX_TOOLWINDOW.0 as i32
    } else {
        current | WS_EX_NOACTIVATE.0 as i32 | WS_EX_TOOLWINDOW.0 as i32
    };
    unsafe {
        SetWindowLongW(hwnd, GWL_EXSTYLE, next);
    }
    Ok(())
}

fn toolbar_position<R: Runtime>(
    app: &AppHandle<R>,
    anchor: Rect,
    width: i32,
    height: i32,
) -> (i32, i32, ToolbarPlacement) {
    let preferred_x = anchor.x + anchor.width / 2 - width / 2;
    let preferred_y = anchor.y - height - EDGE_MARGIN;
    let monitor = app
        .monitor_from_point(anchor.x as f64, anchor.y as f64)
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return (
            preferred_x,
            preferred_y.max(EDGE_MARGIN),
            ToolbarPlacement::Above,
        );
    };
    let work = monitor.work_area();
    clamp_toolbar_position(
        preferred_x,
        preferred_y,
        anchor,
        width,
        height,
        (
            work.position.x,
            work.position.y,
            work.size.width as i32,
            work.size.height as i32,
        ),
    )
}

fn clamp_toolbar_position(
    preferred_x: i32,
    preferred_y: i32,
    anchor: Rect,
    width: i32,
    height: i32,
    work: (i32, i32, i32, i32),
) -> (i32, i32, ToolbarPlacement) {
    let (work_x, work_y, work_width, work_height) = work;
    let max_x = work_x + work_width - width - EDGE_MARGIN;
    let max_y = work_y + work_height - height - EDGE_MARGIN;
    let x = preferred_x.clamp(work_x + EDGE_MARGIN, max_x.max(work_x + EDGE_MARGIN));
    let above_fits = preferred_y >= work_y + EDGE_MARGIN;
    let (desired_y, placement) = if above_fits {
        (preferred_y, ToolbarPlacement::Above)
    } else {
        (
            anchor.y + anchor.height + EDGE_MARGIN,
            ToolbarPlacement::Below,
        )
    };
    let y = desired_y.clamp(work_y + EDGE_MARGIN, max_y.max(work_y + EDGE_MARGIN));
    (x, y, placement)
}

/// Hit-test against the toolbar's *opaque content*, not the window.
///
/// The window is intentionally larger than the pill so the drop shadow and the
/// enter/exit scale have room. That surplus is fully transparent, and Tauri
/// cannot make part of a window click-through — so treating the whole window as
/// "inside" turned the margin into a dead zone: clicks there neither pressed a
/// button nor dismissed the toolbar.
///
/// The content is more than the pill, though. While the language list is open
/// it is a sibling of the capsule inside the same window, so testing the
/// capsule alone made every click in that list read as "the user moved on":
/// `dismiss(Interrupted)` cleared the candidate before the click's own handler
/// could run, and choosing a language failed with a stale candidate. Falls back
/// to the window box until the renderer has reported anything (i.e. before the
/// first measure).
fn point_inside_toolbar<R: Runtime>(
    app: &AppHandle<R>,
    inner: &Arc<SelectionToolbarInner>,
    x: i32,
    y: i32,
) -> bool {
    let Some(window) = app.get_webview_window(SELECTION_TOOLBAR_LABEL) else {
        return false;
    };
    if !window.is_visible().unwrap_or(false) {
        return false;
    }
    let Ok(position) = window.outer_position() else {
        return false;
    };
    let Ok(size) = window.outer_size() else {
        return false;
    };
    let scale = window.scale_factor().unwrap_or(1.0);
    let origin = (position.x, position.y);
    let rects = inner.hit_rects.lock();
    if rects.is_empty() {
        let whole = Rect {
            x: 0,
            y: 0,
            width: size.width as i32,
            height: size.height as i32,
        };
        return point_in_window_rect(origin, whole, x, y);
    }
    point_in_any_rect(origin, &rects, scale, x, y)
}

/// Pure half of `point_inside_toolbar` — testable without a live window.
fn point_in_any_rect(origin: (i32, i32), rects: &[Rect], scale: f64, x: i32, y: i32) -> bool {
    rects
        .iter()
        .any(|rect| point_in_window_rect(origin, scale_rect(*rect, scale), x, y))
}

/// Convert a renderer-reported rect (logical CSS pixels, relative to the
/// window) into the physical pixels `outer_position` / `outer_size` speak.
fn scale_rect(rect: Rect, scale: f64) -> Rect {
    Rect {
        x: (rect.x as f64 * scale).round() as i32,
        y: (rect.y as f64 * scale).round() as i32,
        width: (rect.width as f64 * scale).round() as i32,
        height: (rect.height as f64 * scale).round() as i32,
    }
}

fn point_in_window_rect(origin: (i32, i32), rect: Rect, x: i32, y: i32) -> bool {
    let left = origin.0 + rect.x;
    let top = origin.1 + rect.y;
    x >= left && y >= top && x < left + rect.width && y < top + rect.height
}

/// Tear down the current candidate.
///
/// `Interrupted` hides immediately — the user clicked, typed or scrolled
/// somewhere else, and an always-on-top pill fading over whatever they just
/// touched reads as lag, not polish. `Idle` and `Completed` get a short grace
/// period so the renderer's exit animation is actually seen; the generation
/// counter makes that delayed hide a no-op if a fresh selection has already
/// claimed the window.
fn dismiss<R: Runtime>(
    app: &AppHandle<R>,
    inner: &Arc<SelectionToolbarInner>,
    reason: DismissReason,
) {
    let generation = inner.generation.fetch_add(1, Ordering::SeqCst) + 1;
    *inner.candidate.lock() = None;
    inner.hit_rects.lock().clear();
    *inner.idle_deadline.lock() = None;
    inner.keep_alive.store(false, Ordering::SeqCst);
    inner.interactive.store(false, Ordering::SeqCst);

    let Some(window) = app.get_webview_window(SELECTION_TOOLBAR_LABEL) else {
        return;
    };
    // Cancel any reveal still queued on the AppKit thread. Without this a
    // reveal in flight when a dismiss lands would run afterwards and leave the
    // capsule on screen until the *next* dismiss.
    #[cfg(target_os = "macos")]
    crate::pet_window::cancel_overlay_panel_reveal(
        crate::pet_window::OverlayPanelRole::SelectionToolbar,
    );
    // Surrendering key here is not optional: a dismiss that arrives while the
    // language list is open would otherwise leave a hidden panel holding the
    // keyboard.
    #[cfg(target_os = "macos")]
    let _ = crate::pet_window::set_overlay_panel_key(&window, false);
    let _ = window.emit(SELECTION_DISMISS_EVENT, DismissPayload { reason });
    if !reason.is_animated() {
        let _ = window.hide();
        return;
    }

    let app = app.clone();
    let inner = inner.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(EXIT_ANIMATION_MS)).await;
        if inner.generation.load(Ordering::SeqCst) != generation {
            return;
        }
        if let Some(window) = app.get_webview_window(SELECTION_TOOLBAR_LABEL) {
            let _ = window.hide();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ACL for the overlay window. The generated `all-app-commands.toml` does
    /// not cover it — that grant hangs off the `default` capability, which is
    /// scoped `windows: ["main"]`.
    const TOOLBAR_PERMISSION_TOML: &str =
        include_str!("../permissions/selection-toolbar-app-commands.toml");
    /// The overlay's capability, which also has to grant the plugin commands
    /// its prefs go through.
    const TOOLBAR_CAPABILITY_JSON: &str = include_str!("../capabilities/selection-toolbar.json");
    /// The renderer's own list of what the overlay invokes. Read rather than
    /// re-typed: a hand-copied mirror in this file only ever asserts that two
    /// stale lists agree with each other.
    const OVERLAY_BRIDGE_TS: &str = include_str!("../../lib/tauri/selection-toolbar.ts");

    /// Pull the command strings out of the `OVERLAY_COMMANDS` object literal.
    fn overlay_commands_from_renderer() -> Vec<String> {
        let start = OVERLAY_BRIDGE_TS
            .find("export const OVERLAY_COMMANDS = {")
            .expect("OVERLAY_COMMANDS moved or was renamed in lib/tauri/selection-toolbar.ts");
        let body = &OVERLAY_BRIDGE_TS[start..];
        let end = body
            .find("} as const")
            .expect("OVERLAY_COMMANDS is not `as const`");
        let mut commands: Vec<String> = body[..end]
            .lines()
            .filter_map(|line| {
                let value = line.split_once(':')?.1.trim().trim_end_matches(',');
                // `listShortcuts: SHORTCUT_LIST_COMMAND` — an imported constant
                // rather than a literal, so resolve the one indirection.
                if value == "SHORTCUT_LIST_COMMAND" {
                    return Some("shortcut_list".to_string());
                }
                Some(value.strip_prefix('"')?.strip_suffix('"')?.to_string())
            })
            .collect();
        commands.sort();
        assert!(
            !commands.is_empty(),
            "parsed no commands out of OVERLAY_COMMANDS — the parser has drifted from the source"
        );
        commands
    }

    #[test]
    fn every_command_the_overlay_invokes_is_granted_to_its_window() {
        // A command missing from the TOML does not fail to build — it is
        // rejected at runtime with "Command not found", which is how the
        // content-hugging resize shipped with the toolbar permanently
        // invisible. The renderer's wrappers all invoke *through*
        // `OVERLAY_COMMANDS`, so this compares the grant against what is
        // actually called rather than against a second copy of the list.
        let mut granted: Vec<String> = TOOLBAR_PERMISSION_TOML
            .lines()
            .filter_map(|line| {
                let trimmed = line.trim().trim_end_matches(',');
                trimmed
                    .strip_prefix('"')?
                    .strip_suffix('"')
                    .map(str::to_string)
            })
            .collect();
        granted.sort();

        // Equality, not containment: an over-grant is a real finding too. This
        // window exists to be least-privilege, and a stale entry left behind
        // after a wrapper is deleted quietly widens it.
        assert_eq!(
            granted,
            overlay_commands_from_renderer(),
            "permissions/selection-toolbar-app-commands.toml and OVERLAY_COMMANDS in \
             lib/tauri/selection-toolbar.ts have diverged"
        );
    }

    #[test]
    fn the_overlay_can_load_the_pref_store_it_reads_from() {
        // `getPref`/`setPref` go through `LazyStore`, which calls
        // `plugin:store|load` before its first get — and swallows the
        // rejection (`lib/tauri/store.ts`), so a missing grant is silent: the
        // default translation language simply never arrived.
        for permission in ["store:allow-load", "store:allow-get", "store:allow-set"] {
            assert!(
                TOOLBAR_CAPABILITY_JSON.contains(permission),
                "{permission} is needed by lib/tauri/store.ts but missing from \
                 capabilities/selection-toolbar.json"
            );
        }
    }

    #[test]
    fn placement_prefers_above_and_clamps_horizontally() {
        let position = clamp_toolbar_position(
            -150,
            120,
            Rect {
                x: 5,
                y: 172,
                width: 20,
                height: 18,
            },
            360,
            44,
            (0, 0, 1280, 720),
        );
        assert_eq!(position, (8, 120, ToolbarPlacement::Above));
    }

    #[test]
    fn placement_moves_below_when_top_edge_has_no_room() {
        let position = clamp_toolbar_position(
            100,
            -20,
            Rect {
                x: 260,
                y: 12,
                width: 50,
                height: 20,
            },
            360,
            44,
            (0, 0, 1280, 720),
        );
        assert_eq!(position, (100, 40, ToolbarPlacement::Below));
    }

    #[test]
    fn a_taller_toolbar_flips_below_where_the_short_one_fit_above() {
        // Same anchor, same screen: only the measured height changes. This is
        // exactly why placement has to come back from `resize` rather than
        // being decided once at candidate time.
        let anchor = Rect {
            x: 400,
            y: 90,
            width: 60,
            height: 20,
        };
        let work = (0, 0, 1280, 720);
        let (_, _, short) = clamp_toolbar_position(400, 90 - 48 - 8, anchor, 200, 48, work);
        let (_, _, tall) = clamp_toolbar_position(400, 90 - 240 - 8, anchor, 200, 240, work);
        assert_eq!(short, ToolbarPlacement::Above);
        assert_eq!(tall, ToolbarPlacement::Below);
    }

    #[test]
    fn hit_test_ignores_the_transparent_shadow_margin() {
        // Window at (100, 100), 240x88 logical; capsule inset by the renderer's
        // 20px shadow padding.
        let capsule = Rect {
            x: 20,
            y: 20,
            width: 200,
            height: 48,
        };
        // Inside the window but in the shadow padding — must NOT count as a hit,
        // otherwise the click is swallowed instead of dismissing the toolbar.
        assert!(!point_in_window_rect((100, 100), capsule, 105, 105));
        // Dead centre of the capsule.
        assert!(point_in_window_rect((100, 100), capsule, 220, 144));
        // Just past the capsule's right edge, still inside the window.
        assert!(!point_in_window_rect((100, 100), capsule, 321, 144));
    }

    #[test]
    fn stopping_releases_only_the_chords_the_toolbar_itself_claimed() {
        // The user re-bound ⌥⇧6 to something of their own, so the renderer
        // replayed that override before the toolbar ever started.
        let user_owned = "selection.speak";
        let mut owned = HashSet::new();
        let mut bound: Vec<String> = Vec::new();
        claim_shortcuts(
            &mut owned,
            |id| id == user_owned,
            |id, _| {
                bound.push(id.to_string());
                Ok::<(), String>(())
            },
        );
        assert_eq!(bound.len(), SELECTION_ACTION_SHORTCUTS.len() - 1);
        assert!(!owned.contains(user_owned));

        let mut released: Vec<String> = Vec::new();
        release_shortcuts(&mut owned, |id| {
            released.push(id.to_string());
            Ok::<(), String>(())
        });
        // The whole point: `ShortcutRegistry::unbind` drops the mapping and
        // unregisters with the OS, so releasing this id would have deleted the
        // user's own chord — one the toolbar deliberately never took.
        assert!(!released.iter().any(|id| id == user_owned));
        assert_eq!(released.len(), SELECTION_ACTION_SHORTCUTS.len() - 1);
        // Nothing is released twice if `stop` is called again.
        assert!(owned.is_empty());
    }

    #[test]
    fn a_chord_that_fails_to_bind_is_never_released() {
        let mut owned = HashSet::new();
        // A conflict with an unrelated shortcut: `start` logs and carries on.
        claim_shortcuts(
            &mut owned,
            |_| false,
            |id, _| {
                if id == "selection.ask" {
                    Err("conflict".to_string())
                } else {
                    Ok(())
                }
            },
        );
        assert!(!owned.contains("selection.ask"));

        let mut released: Vec<String> = Vec::new();
        release_shortcuts(&mut owned, |id| {
            released.push(id.to_string());
            Ok::<(), String>(())
        });
        // Whoever *does* hold that chord keeps it.
        assert!(!released.iter().any(|id| id == "selection.ask"));
    }

    #[test]
    fn hit_test_covers_the_open_language_list_as_well_as_the_capsule() {
        // Window at (100, 100). The list sits above the capsule with the
        // shell's 6px gap between them, and is narrower than the pill.
        let list = Rect {
            x: 40,
            y: 20,
            width: 160,
            height: 120,
        };
        let capsule = Rect {
            x: 20,
            y: 146,
            width: 200,
            height: 48,
        };
        let rects = [list, capsule];
        // Choosing a language must not read as "the user clicked away": before
        // this, the capsule-only test dismissed the candidate here, and the
        // click's own handler then failed with a stale candidate.
        assert!(point_in_any_rect((100, 100), &rects, 1.0, 200, 180));
        // …and the capsule still hits.
        assert!(point_in_any_rect((100, 100), &rects, 1.0, 200, 260));
        // The gap between the two, and the corners beside the narrower list,
        // are transparent — a bounding box would have swallowed both.
        assert!(!point_in_any_rect((100, 100), &rects, 1.0, 160, 243));
        assert!(!point_in_any_rect((100, 100), &rects, 1.0, 130, 200));
        // Still nothing outside the content.
        assert!(!point_in_any_rect((100, 100), &rects, 1.0, 105, 105));
    }

    #[test]
    fn capsule_rect_is_scaled_into_physical_pixels() {
        let scaled = scale_rect(
            Rect {
                x: 20,
                y: 20,
                width: 200,
                height: 48,
            },
            2.0,
        );
        assert_eq!(scaled.x, 40);
        assert_eq!(scaled.width, 400);
        assert_eq!(scaled.height, 96);
    }

    #[test]
    fn only_interrupted_dismissals_skip_the_exit_animation() {
        assert!(!DismissReason::Interrupted.is_animated());
        assert!(DismissReason::Idle.is_animated());
        assert!(DismissReason::Completed.is_animated());
    }

    #[test]
    fn idle_deadline_only_fires_once_it_is_actually_past() {
        let inner = SelectionToolbarInner::default();
        let now = Instant::now();
        *inner.idle_deadline.lock() = Some(now + Duration::from_millis(IDLE_DISMISS_MS));
        assert!(!idle_deadline_passed(&inner, now));
        assert!(idle_deadline_passed(
            &inner,
            now + Duration::from_millis(IDLE_DISMISS_MS + 1)
        ));
        // No deadline (freshly dismissed) never expires.
        *inner.idle_deadline.lock() = None;
        assert!(!idle_deadline_passed(
            &inner,
            now + Duration::from_secs(3600)
        ));
    }

    #[test]
    fn handoff_actions_raise_the_main_window_but_background_ones_do_not() {
        assert!(SelectionToolbarAction::Explain.focuses_main());
        assert!(SelectionToolbarAction::Ask.focuses_main());
        assert!(SelectionToolbarAction::Translate {
            target_locale: "ja".into()
        }
        .focuses_main());
        // Stashing a note or reading text aloud must not yank the app forward.
        assert!(!SelectionToolbarAction::Remember.focuses_main());
        assert!(!SelectionToolbarAction::Speak.focuses_main());
        assert!(!SelectionToolbarAction::Copy.focuses_main());
    }

    #[test]
    fn actions_that_finish_locally_hold_the_toolbar_open() {
        // Copy has to outlive its own checkmark; remember has to be able to
        // report a PII block; speak owns the player.
        assert!(SelectionToolbarAction::Copy.holds_toolbar());
        assert!(SelectionToolbarAction::Remember.holds_toolbar());
        assert!(SelectionToolbarAction::Speak.holds_toolbar());
        // Handing off and raising the main window are the same set: once the
        // app is in front, keeping a floating pill over it is just clutter.
        assert!(!SelectionToolbarAction::Explain.holds_toolbar());
        assert!(!SelectionToolbarAction::Ask.holds_toolbar());
        assert!(!SelectionToolbarAction::Translate {
            target_locale: "de".into()
        }
        .holds_toolbar());
    }

    #[test]
    fn action_shortcuts_are_unique_and_do_not_collide_with_the_clipboard_chord() {
        let ids: HashSet<&str> = SELECTION_ACTION_SHORTCUTS
            .iter()
            .map(|(id, _)| *id)
            .collect();
        let chords: HashSet<&str> = SELECTION_ACTION_SHORTCUTS
            .iter()
            .map(|(_, chord)| *chord)
            .collect();
        assert_eq!(ids.len(), SELECTION_ACTION_SHORTCUTS.len());
        assert_eq!(chords.len(), SELECTION_ACTION_SHORTCUTS.len());
        assert!(!chords.contains("alt+shift+c"));
    }

    #[test]
    fn stage_wire_shape_carries_the_focus_decision() {
        let payload = SelectionStagePayload {
            candidate: ExternalSelectionCandidate {
                id: "c1".into(),
                text: "hello".into(),
                source_app: "TextEdit".into(),
                source_title: None,
                origin: SelectionOrigin::Accessibility,
                anchor_rect: None,
                captured_at: 0,
                truncated: false,
                source_subrole: None,
                source_url: None,
            },
            action: SelectionToolbarAction::Speak,
            focus_main: false,
        };
        let value = serde_json::to_value(payload).unwrap();
        assert_eq!(value["focusMain"], serde_json::json!(false));
        assert_eq!(value["action"]["kind"], serde_json::json!("speak"));
    }

    #[test]
    fn dismiss_payload_is_camel_case_tagged() {
        assert_eq!(
            serde_json::to_value(DismissPayload {
                reason: DismissReason::Interrupted
            })
            .unwrap(),
            serde_json::json!({ "reason": "interrupted" })
        );
    }

    #[test]
    fn action_wire_shape_is_tagged_and_camel_case() {
        let action = SelectionToolbarAction::Translate {
            target_locale: "zh-CN".into(),
        };
        assert_eq!(
            serde_json::to_value(action).unwrap(),
            serde_json::json!({"kind": "translate", "targetLocale": "zh-CN"})
        );
    }

    #[test]
    fn default_sensitive_apps_are_blocked_without_user_configuration() {
        assert!(is_default_blocked_app("1password 8"));
        assert!(is_default_blocked_app("cognia"));
        assert!(is_default_blocked_app("bitwarden.exe"));
        assert!(!is_default_blocked_app("textedit"));
    }

    #[test]
    fn recognizes_escape_by_virtual_key_on_every_platform() {
        // `InputEvent` publishes Windows-style virtual keys everywhere: the
        // macOS tap runs its CGKeyCode through `cg_keycode_to_vk` first. The
        // raw macOS keycode for Escape (53) is the CGKeyCode for `keypad 1`
        // once translated, so matching on it dismissed on the wrong key and
        // never on Escape.
        assert!(is_escape_key(0x1B));
        assert!(!is_escape_key(53));
        assert!(!is_escape_key(0));
    }

    #[test]
    fn modifier_presses_do_not_count_as_moving_on() {
        // Windows' low-level hook reports bare modifiers; without this the
        // ⌥ of ⌥⇧3 dismissed the toolbar before the chord completed.
        for vk in [0x10, 0x11, 0x12, 0x5B, 0xA0, 0xA4] {
            assert!(is_modifier_key(vk), "vk {vk:#04x} should be a modifier");
        }
        // Digits and letters are ordinary keys — they defer to the shortcut
        // claim window rather than being ignored outright.
        for vk in [0x31, 0x36, 0x41, 0x1B] {
            assert!(
                !is_modifier_key(vk),
                "vk {vk:#04x} should not be a modifier"
            );
        }
    }

    /// The keyboard path is broken without this: ⇧→ and ⇧↓ are the keystrokes
    /// that *create* the selection, and they arrive as ordinary `KeyDown`
    /// events. Left alone they land in the "user has moved on" branch and
    /// dismiss the toolbar on the very keystroke that armed it.
    #[test]
    fn selection_navigation_keys_do_not_count_as_moving_on() {
        for vk in [0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28] {
            assert!(
                is_selection_navigation_key(vk, false),
                "vk {vk:#04x} builds a selection and must not dismiss"
            );
        }
        // ⌘A / ^A only counts while a settle is pending. Outside that window
        // `A` is just a letter and must dismiss like any other typing.
        assert!(is_selection_navigation_key(0x41, true));
        assert!(!is_selection_navigation_key(0x41, false));
        // Ordinary typing still dismisses.
        assert!(!is_selection_navigation_key(0x42, true));
        assert!(!is_selection_navigation_key(0x31, true));
    }

    fn press(x: i32, y: i32, ts_ms: i64) -> PressRecord {
        PressRecord { x, y, ts_ms }
    }

    #[test]
    fn a_plain_click_selects_nothing_and_so_costs_nothing() {
        let (intent, count) = classify_release(Some(press(10, 10, 0)), press(12, 11, 40), None, 0);
        assert_eq!(intent, ClickIntent::Ignore);
        assert_eq!(count, 1);
    }

    #[test]
    fn a_drag_reports_its_bounding_box() {
        // The box is also the OCR fallback's capture region, so its origin has
        // to be the top-left corner regardless of drag direction.
        let (intent, _) = classify_release(Some(press(100, 80, 0)), press(40, 20, 120), None, 0);
        assert_eq!(
            intent,
            ClickIntent::Drag {
                bounds: Rect {
                    x: 40,
                    y: 20,
                    width: 60,
                    height: 60
                }
            }
        );
    }

    #[test]
    fn a_sub_threshold_wobble_is_still_a_click() {
        let (intent, _) = classify_release(Some(press(10, 10, 0)), press(15, 14, 30), None, 0);
        assert_eq!(intent, ClickIntent::Ignore);
    }

    #[test]
    fn consecutive_clicks_in_one_spot_become_a_multi_click() {
        let first = press(10, 10, 0);
        let (intent, count) = classify_release(Some(first), press(10, 10, 200), Some(first), 1);
        assert_eq!(intent, ClickIntent::MultiClick { count: 2 });
        assert_eq!(count, 2);

        let second = press(10, 10, 200);
        let (intent, count) = classify_release(Some(second), press(11, 10, 380), Some(second), 2);
        assert_eq!(intent, ClickIntent::MultiClick { count: 3 });
        assert_eq!(count, 3);
    }

    #[test]
    fn a_slow_or_distant_second_click_starts_a_new_run() {
        let first = press(10, 10, 0);
        // Too late.
        let (intent, count) = classify_release(Some(first), press(10, 10, 900), Some(first), 1);
        assert_eq!(intent, ClickIntent::Ignore);
        assert_eq!(count, 1);
        // Too far.
        let (intent, count) = classify_release(Some(first), press(60, 10, 100), Some(first), 1);
        assert!(matches!(intent, ClickIntent::Drag { .. }));
        assert_eq!(count, 1);
    }

    fn a_drag() -> ClickIntent {
        ClickIntent::Drag {
            bounds: Rect {
                x: 0,
                y: 0,
                width: 40,
                height: 12,
            },
        }
    }

    /// The arbitration that stops both layers reading the same selection.
    #[test]
    fn a_gesture_the_observer_already_saw_belongs_to_the_observer() {
        assert_eq!(
            resolve_trigger(a_drag(), true),
            Some(SelectionTrigger::AxObserver)
        );
        // Even a gesture the click gate would have ignored: a double-click in
        // a talkative app is the observer's, and its settle will publish it.
        assert_eq!(
            resolve_trigger(ClickIntent::Ignore, true),
            Some(SelectionTrigger::AxObserver)
        );
    }

    #[test]
    fn an_app_that_posted_nothing_falls_back_to_the_click_path() {
        assert_eq!(
            resolve_trigger(a_drag(), false),
            Some(SelectionTrigger::Click)
        );
        assert_eq!(
            resolve_trigger(ClickIntent::MultiClick { count: 2 }, false),
            Some(SelectionTrigger::Click)
        );
    }

    /// Regression guard for the shape this replaced. Routing by "which app is
    /// this" needed a pid taken from the last notification, which made the
    /// comparison true by construction and stranded a user who moved from a
    /// talkative app to a silent one. Arbitration must depend only on whether
    /// THIS gesture was observed.
    #[test]
    fn arbitration_does_not_depend_on_any_app_reputation() {
        assert_eq!(
            resolve_trigger(a_drag(), false),
            Some(SelectionTrigger::Click),
            "a silent app must read on release no matter what came before it"
        );
    }

    #[test]
    fn a_plain_click_triggers_neither_layer() {
        assert_eq!(resolve_trigger(ClickIntent::Ignore, false), None);
    }

    #[test]
    fn a_settling_selection_pushes_its_deadline_out_rather_than_firing() {
        // This is the debounce: every keystroke of a ⇧→ run re-arms, so the
        // capsule appears once the caret stops instead of strobing.
        let first = settle_decision(3, 1_000);
        let second = settle_decision(4, 1_120);
        match (first, second) {
            (
                SettleAction::Arm {
                    deadline_ms: first_deadline,
                },
                SettleAction::Arm {
                    deadline_ms: second_deadline,
                },
            ) => assert!(second_deadline > first_deadline),
            other => panic!("expected two arms, got {other:?}"),
        }
    }

    #[test]
    fn an_emptied_selection_dismisses_immediately() {
        assert_eq!(settle_decision(0, 1_000), SettleAction::DismissNow);
    }

    #[test]
    fn select_all_is_too_large_to_raise_the_toolbar() {
        // ⌘A over a document: the user is about to replace or delete it, not
        // translate it, and a capsule over the selection is pure obstruction.
        assert_eq!(
            settle_decision(SELECTION_MAX_AUTO_RAISE_CHARS + 1, 1_000),
            SettleAction::Ignore
        );
        assert!(matches!(
            settle_decision(SELECTION_MAX_AUTO_RAISE_CHARS, 1_000),
            SettleAction::Arm { .. }
        ));
    }

    #[test]
    fn an_unmeasurable_length_still_arms_and_is_rechecked_after_the_read() {
        // Windows UIA hands the callback no length. Arming on `-1` is what
        // keeps the feature working there; `spawn_publish` re-applies the
        // bound once it has the real text.
        assert!(matches!(
            settle_decision(-1, 1_000),
            SettleAction::Arm { .. }
        ));
    }

    /// The renderer's classifier is a UX filter, not a security boundary. A
    /// compromised — or merely buggy — overlay must not be able to route an
    /// arbitrary scheme to the OS opener.
    #[test]
    fn open_link_refuses_every_scheme_but_http_and_https() {
        for hostile in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "vbscript:msgbox",
            "not a url at all",
            "",
        ] {
            let action = SelectionToolbarAction::OpenLink {
                url: hostile.to_string(),
            };
            assert_eq!(
                action.open_target("ignored"),
                None,
                "{hostile} must never reach the opener"
            );
        }
        let ok = SelectionToolbarAction::OpenLink {
            url: "https://example.com/a".into(),
        };
        assert_eq!(
            ok.open_target("ignored").as_deref(),
            Some("https://example.com/a")
        );
    }

    #[test]
    fn compose_email_builds_its_own_uri_and_rejects_header_injection() {
        let good = SelectionToolbarAction::ComposeEmail {
            address: "someone@example.com".into(),
        };
        assert_eq!(
            good.open_target("ignored").as_deref(),
            Some("mailto:someone@example.com")
        );
        // Anything that could smuggle extra headers or a second recipient.
        for hostile in [
            "someone@example.com?bcc=attacker@evil.com",
            "someone@example.com\nBcc: attacker@evil.com",
            "someone@example.com&subject=x",
            "two@@example.com",
            "no-at-sign",
            "@example.com",
            "someone@",
            "",
        ] {
            let action = SelectionToolbarAction::ComposeEmail {
                address: hostile.to_string(),
            };
            assert_eq!(
                action.open_target("ignored"),
                None,
                "{hostile} must be refused"
            );
        }
    }

    #[test]
    fn search_uses_the_rust_engine_table_and_encodes_the_query() {
        let action = SelectionToolbarAction::SearchWeb {
            engine: "duckduckgo".into(),
        };
        let target = action.open_target("rust & c++ #1").unwrap();
        assert!(target.starts_with("https://duckduckgo.com/?q="));
        // `&` and `#` must not be able to restructure the request.
        assert!(!target.contains(" & "));
        assert!(!target.trim_end_matches(|c: char| c != '#').contains("#1"));

        // An engine id the table does not know is refused, not concatenated.
        let unknown = SelectionToolbarAction::SearchWeb {
            engine: "attacker-controlled".into(),
        };
        assert_eq!(unknown.open_target("hello"), None);
        // Nothing to search for.
        assert_eq!(
            SelectionToolbarAction::SearchWeb {
                engine: "google".into()
            }
            .open_target("   "),
            None
        );
    }

    #[test]
    fn launch_actions_leave_the_toolbar_and_never_raise_the_main_window() {
        // `holds_toolbar` used to be `!focuses_main()`. `launch` answers no to
        // both, so leaving that identity in place would have parked an
        // always-on-top pill beside a browser already in front.
        for action in [
            SelectionToolbarAction::OpenLink {
                url: "https://example.com".into(),
            },
            SelectionToolbarAction::ComposeEmail {
                address: "a@b.com".into(),
            },
            SelectionToolbarAction::SearchWeb {
                engine: "google".into(),
            },
        ] {
            assert!(action.launches_externally());
            assert!(!action.focuses_main());
            assert!(!action.holds_toolbar());
        }
    }

    /// Guards the TS/Rust mirror. `convertUnit` is a `handoff` on the renderer
    /// side, so it stages a prompt whose answer is only readable in the
    /// composer — if Rust did not raise the main window, that answer would
    /// arrive somewhere the user never sees.
    #[test]
    fn convert_unit_behaves_like_the_other_composer_handoffs() {
        let action = SelectionToolbarAction::ConvertUnit;
        assert!(!action.launches_externally());
        assert!(action.focuses_main());
        assert!(!action.holds_toolbar());
        assert_eq!(action.open_target("38°C"), None);
    }

    /// Query strings are where session tokens, search terms and email
    /// addresses live, and the redaction gate downstream only recognizes the
    /// `user:pass@host` shape — so they have to be dropped here, before the
    /// URL ever becomes model input.
    #[test]
    fn source_url_keeps_the_page_but_drops_everything_sensitive() {
        assert_eq!(
            trim_source_url(Some(
                "https://example.com/docs/a?token=secret&q=my+search#frag"
            )),
            Some("https://example.com/docs/a".to_string())
        );
        assert_eq!(
            trim_source_url(Some("https://user:pw@example.com/x")),
            Some("https://example.com/x".to_string())
        );
        // Non-web schemes carry no page context worth the risk.
        assert_eq!(trim_source_url(Some("file:///Users/me/secret.txt")), None);
        assert_eq!(trim_source_url(Some("javascript:alert(1)")), None);
        assert_eq!(trim_source_url(Some("not a url")), None);
        assert_eq!(trim_source_url(None), None);
    }

    fn big_drag() -> ClickIntent {
        ClickIntent::Drag {
            bounds: Rect {
                x: 10,
                y: 10,
                width: 240,
                height: 30,
            },
        }
    }

    /// The trap this whole gate exists for. macOS does not error when the
    /// Screen Recording grant is missing — it returns the desktop with every
    /// window's contents omitted. OCR would then read the *wallpaper* and this
    /// code would hand it back as the user's selection, to be sent to a model
    /// or written into long-term memory.
    #[test]
    fn never_captures_the_screen_without_the_recording_permission() {
        assert!(!ocr_fallback_allowed(big_drag(), false, false, false, true));
    }

    #[test]
    fn ocr_fallback_requires_every_gate_at_once() {
        // All clear.
        assert!(ocr_fallback_allowed(big_drag(), false, false, true, true));
        // Flip exactly one condition at a time; each alone must veto.
        assert!(!ocr_fallback_allowed(big_drag(), true, false, true, true));
        assert!(!ocr_fallback_allowed(big_drag(), false, true, true, true));
        assert!(!ocr_fallback_allowed(big_drag(), false, false, true, false));
    }

    #[test]
    fn ocr_fallback_needs_a_real_drag_with_room_for_text() {
        // A click gives no region; guessing one would screenshot a rectangle
        // the user never indicated.
        assert!(!ocr_fallback_allowed(
            ClickIntent::Ignore,
            false,
            false,
            true,
            true
        ));
        assert!(!ocr_fallback_allowed(
            ClickIntent::MultiClick { count: 2 },
            false,
            false,
            true,
            true
        ));
        // A sliver too small to hold legible glyphs.
        let sliver = ClickIntent::Drag {
            bounds: Rect {
                x: 0,
                y: 0,
                width: 200,
                height: 4,
            },
        };
        assert!(!ocr_fallback_allowed(sliver, false, false, true, true));
    }

    #[test]
    fn the_capture_region_is_padded_around_the_drag() {
        // Glyphs clipped by the exact selection rectangle (descenders, the
        // last character) must still land inside the captured image.
        assert_eq!(
            pad_rect(
                Rect {
                    x: 20,
                    y: 30,
                    width: 100,
                    height: 16
                },
                6
            ),
            Rect {
                x: 14,
                y: 24,
                width: 112,
                height: 28
            }
        );
    }

    #[test]
    fn ocr_origin_is_on_the_wire_as_its_own_trust_level() {
        // Downstream (composer chip, memory provenance) branches on this, so
        // it must not collapse into `accessibility`.
        assert_eq!(
            serde_json::to_value(SelectionOrigin::Ocr).unwrap(),
            serde_json::json!("ocr")
        );
        assert_ne!(
            serde_json::to_value(SelectionOrigin::Ocr).unwrap(),
            serde_json::to_value(SelectionOrigin::Accessibility).unwrap()
        );
    }

    #[test]
    fn republishing_the_same_selection_is_suppressed() {
        let snapshot = build_text_selection("hello", "TextEdit", None, None).unwrap();
        let candidate = ExternalSelectionCandidate::from_snapshot(
            snapshot.clone(),
            SelectionOrigin::Accessibility,
        );
        assert!(is_same_selection(&candidate, &snapshot));

        let elsewhere = build_text_selection("hello", "Safari", None, None).unwrap();
        assert!(!is_same_selection(&candidate, &elsewhere));
        let different = build_text_selection("goodbye", "TextEdit", None, None).unwrap();
        assert!(!is_same_selection(&candidate, &different));
    }

    #[test]
    fn a_shortcut_claim_stands_down_the_key_press_that_produced_it() {
        // Both halves of the real decision: `dispatch_shortcut` calls
        // `claim_key_press`, and the tap's grace-window task calls
        // `key_press_was_claimed` before dismissing.
        let inner = SelectionToolbarInner::default();
        let key_ts = 1_000_i64;

        // Nothing has claimed it: the grace window expires and the toolbar goes
        // away, which is what typing elsewhere should do.
        assert!(!key_press_was_claimed(&inner, key_ts));

        // The `3` of ⌥⇧3 reaches the tap and `dispatch_shortcut` fires for the
        // same press. Without this the chord cancelled itself.
        claim_key_press(&inner, key_ts);
        assert!(key_press_was_claimed(&inner, key_ts));

        // A chord that fired slightly after the tap saw the key still owns it —
        // the two arrive in either order.
        let inner = SelectionToolbarInner::default();
        claim_key_press(&inner, key_ts + 2);
        assert!(key_press_was_claimed(&inner, key_ts));

        // But a stale claim never suppresses the *next* press, or one chord
        // would mute every keystroke that followed it.
        assert!(!key_press_was_claimed(&inner, key_ts + 3));
    }
}
