//! Runtime white-screen watchdog for the main webview.
//!
//! `window_recovery` + the boot-reveal guard handle *boot-time* blanking — an
//! off-screen restore, or a renderer that never paints its first frame. The
//! guard is armed only after Tauri reports the initial document as loaded, so a
//! slow Next.js dev compile cannot expose an unpainted black webview. After a
//! healthy boot, this module also handles renderer-process crashes (WebView2
//! `ProcessFailed`, WKWebView content-process termination, GPU/OOM kills), a
//! wedged main thread, or navigation to a blank/broken document. In every one
//! of those cases the JS realm is gone or frozen, so the React error boundaries
//! in `app/error.tsx` / `app/global-error.tsx` can never fire — the user is left
//! staring at a white screen with no way back.
//!
//! Tauri exposes no cross-platform "renderer crashed" signal, so we detect the
//! condition indirectly. The renderer installs a realm-lifetime heartbeat
//! (`lib/tauri/webview-watchdog.ts`) that pings [`webview_heartbeat`] every few
//! seconds. The heartbeat is a module-level interval, **not** a React effect, so
//! it keeps beating across React unmounts (the route error boundary, the
//! global-error swap) and stops only when the realm itself dies or freezes —
//! precisely the white-screen condition. When the beats stop for longer than
//! [`HEARTBEAT_TIMEOUT`] while the window is visible, the watchdog reloads the
//! page by navigating the webview back to its last-known-good URL.
//!
//! The decision logic ([`decide`]) is a pure function so the truth table is unit
//! tested without a live window; [`recover`] is the thin Tauri-IO seam around it.
//!
//! On macOS/iOS WKWebView *does* report one crash class directly:
//! `webViewWebContentProcessDidTerminate:` (Tauri's
//! `Builder::on_web_content_process_terminate`). Registering that hook replaces
//! Tauri's built-in reload, so [`handle_web_content_process_terminate`] owns the
//! recovery: it records the termination in [`RendererLifecycle`] (a per-webview
//! renderer generation that the agent-debug bridge uses to fail in-flight
//! evaluations with "renderer restarted" and to wait for the replacement
//! renderer before re-injecting its helper), then reloads the webview right
//! away instead of waiting for the heartbeat timeout — and does so even while
//! the window is hidden, because a terminated process is certainly dead,
//! unlike a hidden window's throttled heartbeat.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// How long the renderer may go silent before we treat the page as dead. Set
/// generously so a heavy synchronous task (which blocks heartbeats just like a
/// crash would) doesn't trip a false reload — a main thread blocked this long is
/// already a broken experience that a reload legitimately fixes.
pub const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(15);

/// Watchdog poll cadence. The renderer beats roughly every 4s, so a 3s poll
/// reacts within one interval of the timeout elapsing.
pub const POLL_INTERVAL: Duration = Duration::from_secs(3);

/// Maximum automatic reloads before we stop trying. A page that white-screens
/// again within [`HEARTBEAT_TIMEOUT`] of every reload is unrecoverable by
/// reloading; hammering it just flashes the window forever.
pub const MAX_RECOVERIES: u32 = 3;

/// Once the page has been continuously alive for this long past the last
/// recovery, the reload budget resets — so a reload-loop (beat once, die) can't
/// keep clearing the budget, but an unrelated crash minutes later still gets the
/// full retry allowance.
pub const RECOVERY_COUNTER_RESET: Duration = Duration::from_secs(120);

/// Grace period after the initial document has finished loading for React to
/// reveal the hidden main window itself.
pub const BOOT_REVEAL_GRACE: Duration = Duration::from_secs(8);

/// Environment switch that re-arms heartbeat recovery in a debug build.
pub const HEARTBEAT_RECOVERY_ENV: &str = "COGNIA_WEBVIEW_WATCHDOG";

/// Pure decision: should the heartbeat-timeout reload loop run at all?
///
/// Not in a debug build. `pnpm tauri dev` serves the page from `next dev`, and
/// Turbopack compiling a route on first visit routinely blocks the renderer
/// longer than [`HEARTBEAT_TIMEOUT`], so the loop "recovered" a healthy page
/// by reloading it, sometimes twice in a row right after launch. That is a
/// shipped-build safety net misfiring against a dev server. `1`/`true` in
/// [`HEARTBEAT_RECOVERY_ENV`] turns it back on to exercise it in dev; `0`/`false`
/// turns it off in a release build for diagnosis. The content-process
/// termination reload and the boot-reveal safety net are separate and stay on.
pub fn heartbeat_recovery_enabled_for(debug_build: bool, env_override: Option<&str>) -> bool {
    match env_override.map(str::trim) {
        Some("1") | Some("true") => true,
        Some("0") | Some("false") => false,
        _ => !debug_build,
    }
}

/// [`heartbeat_recovery_enabled_for`] for this process.
pub fn heartbeat_recovery_enabled() -> bool {
    let env_override = std::env::var(HEARTBEAT_RECOVERY_ENV).ok();
    heartbeat_recovery_enabled_for(cfg!(debug_assertions), env_override.as_deref())
}

/// What the boot-time reveal safety net should do.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BootRevealAction {
    Idle,
    Reveal,
}

/// Whether a Tauri page-load callback belongs to the one event that may arm
/// the main-window boot reveal guard.
pub fn should_arm_boot_reveal(webview_label: &str, load_finished: bool) -> bool {
    webview_label == "main" && load_finished
}

/// Pure boot-time reveal decision. `None` means the initial document has not
/// finished loading yet (for example while Next.js is compiling `/` in dev).
pub fn decide_boot_reveal(
    elapsed_since_finished_load: Option<Duration>,
    visible: bool,
    renderer_revealed: bool,
    grace: Duration,
) -> BootRevealAction {
    if visible || renderer_revealed || elapsed_since_finished_load.is_none() {
        return BootRevealAction::Idle;
    }

    if elapsed_since_finished_load.is_some_and(|elapsed| elapsed >= grace) {
        BootRevealAction::Reveal
    } else {
        BootRevealAction::Idle
    }
}

/// What the watchdog should do on a given poll.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WatchdogAction {
    /// Page looks alive, or we have no basis to act yet — do nothing.
    Idle,
    /// Beats stopped past the threshold — reload the page.
    Recover,
    /// Reloading hasn't helped (budget exhausted) — stop trying.
    GaveUp,
}

/// Pure decision: given how long since the last heartbeat (`None` = never beat),
/// whether the window is visible, and how many recoveries we've already spent,
/// decide the action. Hidden windows and not-yet-booted renderers are always
/// [`WatchdogAction::Idle`] — we never reload a page that hasn't proven it can
/// boot (the boot-reveal guard owns that path) or one the user can't even see.
pub fn decide(
    elapsed_since_beat: Option<Duration>,
    visible: bool,
    recoveries: u32,
    timeout: Duration,
    max_recoveries: u32,
) -> WatchdogAction {
    if !visible {
        return WatchdogAction::Idle;
    }
    let Some(elapsed) = elapsed_since_beat else {
        return WatchdogAction::Idle;
    };
    if elapsed <= timeout {
        return WatchdogAction::Idle;
    }
    if recoveries >= max_recoveries {
        WatchdogAction::GaveUp
    } else {
        WatchdogAction::Recover
    }
}

#[derive(Default)]
struct Inner {
    /// Set once, when Tauri reports the main document's first `Finished` load.
    /// A pending dev-server response deliberately leaves this `None`.
    initial_load_finished_at: Option<Instant>,
    /// Latched by the renderer immediately after `window.show()` succeeds.
    /// Once true, a later user-initiated hide-to-tray must never be mistaken
    /// for a boot failure by the one-shot safety timer.
    renderer_revealed: bool,
    /// `None` until the first heartbeat — see [`decide`].
    last_beat: Option<Instant>,
    /// Last-known-good route, used as the reload target so recovery preserves
    /// the page the user was on instead of dumping them at the app root.
    last_url: Option<String>,
    /// Reloads spent since the budget last reset.
    recoveries: u32,
    last_recovery: Option<Instant>,
    /// Latches the give-up warning so it logs once, not every poll.
    gave_up_logged: bool,
    /// Armed on recovery, consumed by the reloaded renderer to toast the user.
    pending_notice: bool,
}

/// Shared watchdog state. Registered via `.manage()`; the heartbeat command
/// writes it and the polling loop reads it.
pub struct WebviewWatchdog {
    inner: Mutex<Inner>,
}

impl Default for WebviewWatchdog {
    fn default() -> Self {
        Self::new()
    }
}

impl WebviewWatchdog {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
        }
    }

    /// Arm the one-shot boot reveal grace period after the initial document
    /// finishes loading. Returns `true` only for the first finished load so
    /// later navigations cannot surface a window the user hid to the tray.
    pub fn record_initial_load_finished(&self, now: Instant) -> bool {
        let mut inner = self.inner.lock().unwrap();
        if inner.initial_load_finished_at.is_some() {
            return false;
        }
        inner.initial_load_finished_at = Some(now);
        true
    }

    /// Permanently disarm the boot force-show fallback after the renderer has
    /// successfully revealed the main window.
    pub fn acknowledge_boot_reveal(&self) {
        self.inner.lock().unwrap().renderer_revealed = true;
    }

    /// Decide whether the one-shot boot safety net should reveal the window.
    pub fn poll_boot_reveal(&self, now: Instant, visible: bool) -> BootRevealAction {
        let inner = self.inner.lock().unwrap();
        let elapsed = inner
            .initial_load_finished_at
            .and_then(|finished| now.checked_duration_since(finished));
        decide_boot_reveal(elapsed, visible, inner.renderer_revealed, BOOT_REVEAL_GRACE)
    }

    /// Record a renderer heartbeat (current URL + arrival time). Resets the
    /// reload budget once the page has been alive for [`RECOVERY_COUNTER_RESET`]
    /// past the last recovery.
    pub fn record_heartbeat(&self, url: Option<String>, now: Instant) {
        let mut inner = self.inner.lock().unwrap();
        inner.last_beat = Some(now);
        if let Some(url) = url {
            if !url.is_empty() {
                inner.last_url = Some(url);
            }
        }
        if let Some(last_recovery) = inner.last_recovery {
            if now.duration_since(last_recovery) > RECOVERY_COUNTER_RESET {
                inner.recoveries = 0;
                inner.last_recovery = None;
                inner.gave_up_logged = false;
            }
        }
    }

    /// Decide the action for this poll given the window's visibility.
    pub fn poll(&self, now: Instant, visible: bool) -> WatchdogAction {
        let inner = self.inner.lock().unwrap();
        let elapsed = inner.last_beat.map(|beat| now.duration_since(beat));
        decide(
            elapsed,
            visible,
            inner.recoveries,
            HEARTBEAT_TIMEOUT,
            MAX_RECOVERIES,
        )
    }

    /// The URL to reload to on recovery (last-known-good route).
    pub fn last_url(&self) -> Option<String> {
        self.inner.lock().unwrap().last_url.clone()
    }

    /// Mark that a recovery just happened: spend a reload from the budget, arm
    /// the post-recovery notice, and grace the heartbeat clock so the reloaded
    /// page gets a full [`HEARTBEAT_TIMEOUT`] to come alive before it's judged
    /// again (otherwise the next poll, finding no fresh beat yet, would spend the
    /// whole budget in seconds).
    pub fn note_recovery(&self, now: Instant) {
        let mut inner = self.inner.lock().unwrap();
        inner.recoveries += 1;
        inner.last_recovery = Some(now);
        inner.last_beat = Some(now);
        inner.pending_notice = true;
    }

    /// Consume the one-shot "we just recovered you" flag. The freshly-loaded
    /// renderer calls this on boot to decide whether to toast.
    pub fn take_recovery_notice(&self) -> bool {
        let mut inner = self.inner.lock().unwrap();
        std::mem::take(&mut inner.pending_notice)
    }

    /// Latch the give-up log. Returns `true` only the first time, so the polling
    /// loop warns once instead of every [`POLL_INTERVAL`].
    pub fn mark_gave_up_logged(&self) -> bool {
        let mut inner = self.inner.lock().unwrap();
        if inner.gave_up_logged {
            false
        } else {
            inner.gave_up_logged = true;
            true
        }
    }
}

/// Reload the webview by navigating it back to `url` (last-known-good route) or,
/// when that's missing/unparseable, its current URL. Best-effort: logs and
/// returns `false` on any failure (the next poll will simply try again).
pub fn recover<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>, url: Option<&str>) -> bool {
    let target = url
        .and_then(|raw| tauri::Url::parse(raw).ok())
        .or_else(|| window.url().ok());
    let Some(target) = target else {
        log::error!("webview-watchdog: no URL to reload to; cannot recover blank webview");
        return false;
    };
    match window.navigate(target.clone()) {
        Ok(()) => {
            log::warn!("webview-watchdog: blank/dead webview detected — reloaded to {target}");
            true
        }
        Err(err) => {
            log::error!("webview-watchdog: navigate failed during recovery: {err}");
            false
        }
    }
}

/// Renderer heartbeat sink. Called every few seconds by the realm-lifetime
/// interval in `lib/tauri/webview-watchdog.ts`.
#[tauri::command]
pub fn webview_heartbeat(state: tauri::State<'_, WebviewWatchdog>, url: Option<String>) {
    state.record_heartbeat(url, Instant::now());
}

/// Disarm the boot-time force-show fallback after the renderer successfully
/// calls `show()` for the main window.
#[tauri::command]
pub fn webview_acknowledge_boot_reveal(state: tauri::State<'_, WebviewWatchdog>) {
    state.acknowledge_boot_reveal();
}

/// Returns (and clears) whether the page was just auto-recovered from a blank
/// screen, so the reloaded renderer can surface a toast.
#[tauri::command]
pub fn webview_take_recovery_notice(state: tauri::State<'_, WebviewWatchdog>) -> bool {
    state.take_recovery_notice()
}

// ---------------------------------------------------------------------------
// Renderer (web content process) lifecycle
// ---------------------------------------------------------------------------

/// Renderer lifecycle of one webview, as observed from the native side.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RendererState {
    /// Web content process terminations observed for this webview. A change
    /// between two observations means the renderer was replaced in between, so
    /// any script evaluation issued to the old one will never be answered.
    pub generation: u64,
    /// True from a termination until the replacement renderer commits its
    /// first document; evaluations sent before that have no realm to run in.
    pub awaiting_load: bool,
}

/// Whether a terminated renderer should be reloaded or left alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminationRecovery {
    /// Reload the webview so a fresh renderer takes over.
    Reload,
    /// The renderer died [`MAX_RECOVERIES`] times inside
    /// [`RECOVERY_COUNTER_RESET`]; reloading again would only flash the window.
    GaveUp,
}

/// Pure budget decision: reload unless `recent` terminations (already
/// including the one being handled) exceed `max` within the reset window.
pub fn decide_termination_recovery(recent: usize, max: u32) -> TerminationRecovery {
    if recent > max as usize {
        TerminationRecovery::GaveUp
    } else {
        TerminationRecovery::Reload
    }
}

#[derive(Debug, Default)]
struct RendererRecord {
    state: RendererState,
    /// Termination instants inside the [`RECOVERY_COUNTER_RESET`] window.
    recent_terminations: Vec<Instant>,
}

struct RendererLifecycleInner {
    records: Mutex<HashMap<String, RendererRecord>>,
    /// Bumped on every lifecycle change so async waiters can re-check state.
    epoch: tokio::sync::watch::Sender<u64>,
}

/// Per-webview renderer generations, shared by the termination hook (writer),
/// `on_page_load` (writer), and the agent-debug bridge (reader/waiter).
/// Cheap to clone; every clone observes the same state.
#[derive(Clone)]
pub struct RendererLifecycle {
    inner: Arc<RendererLifecycleInner>,
}

impl Default for RendererLifecycle {
    fn default() -> Self {
        Self::new()
    }
}

impl RendererLifecycle {
    pub fn new() -> Self {
        let (epoch, _) = tokio::sync::watch::channel(0);
        Self {
            inner: Arc::new(RendererLifecycleInner {
                records: Mutex::new(HashMap::new()),
                epoch,
            }),
        }
    }

    fn bump(&self) {
        self.inner
            .epoch
            .send_modify(|epoch| *epoch = epoch.wrapping_add(1));
    }

    /// Current state for `label` (default for a webview never seen).
    pub fn state(&self, label: &str) -> RendererState {
        self.inner
            .records
            .lock()
            .unwrap()
            .get(label)
            .map(|record| record.state)
            .unwrap_or_default()
    }

    /// Every webview that has a lifecycle record, ordered by label.
    pub fn snapshot(&self) -> BTreeMap<String, RendererState> {
        self.inner
            .records
            .lock()
            .unwrap()
            .iter()
            .map(|(label, record)| (label.clone(), record.state))
            .collect()
    }

    /// Record a web content process termination. Returns the new state and the
    /// recovery decision under the per-webview reload budget.
    pub fn record_termination(
        &self,
        label: &str,
        now: Instant,
    ) -> (RendererState, TerminationRecovery) {
        let result = {
            let mut records = self.inner.records.lock().unwrap();
            let record = records.entry(label.to_string()).or_default();
            record.state.generation += 1;
            record.state.awaiting_load = true;
            record
                .recent_terminations
                .retain(|at| now.saturating_duration_since(*at) <= RECOVERY_COUNTER_RESET);
            record.recent_terminations.push(now);
            (
                record.state,
                decide_termination_recovery(record.recent_terminations.len(), MAX_RECOVERIES),
            )
        };
        self.bump();
        result
    }

    /// A document started loading in `label`: a live renderer exists again.
    pub fn record_page_load(&self, label: &str) {
        let changed = {
            let mut records = self.inner.records.lock().unwrap();
            match records.get_mut(label) {
                Some(record) if record.state.awaiting_load => {
                    record.state.awaiting_load = false;
                    true
                }
                _ => false,
            }
        };
        if changed {
            self.bump();
        }
    }

    /// Resolve once `label`'s renderer has terminated past `generation`.
    /// Never resolves while the renderer stays alive; callers race it.
    pub async fn wait_for_termination(&self, label: &str, generation: u64) {
        let mut epoch = self.inner.epoch.subscribe();
        loop {
            if self.state(label).generation > generation {
                return;
            }
            if epoch.changed().await.is_err() {
                // The sender lives as long as `self`; unreachable in practice.
                std::future::pending::<()>().await;
            }
        }
    }

    /// Wait up to `timeout` for a replacement renderer after a termination.
    /// Returns the state observed last; `awaiting_load` is still true on timeout.
    pub async fn wait_until_loaded(&self, label: &str, timeout: Duration) -> RendererState {
        let mut epoch = self.inner.epoch.subscribe();
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let state = self.state(label);
            if !state.awaiting_load {
                return state;
            }
            match tokio::time::timeout_at(deadline, epoch.changed()).await {
                Ok(Ok(())) => continue,
                Ok(Err(_)) | Err(_) => return self.state(label),
            }
        }
    }
}

/// `Builder::on_web_content_process_terminate` handler (macOS/iOS). Replaces
/// Tauri's built-in reload, so it must reload itself.
#[cfg(any(target_os = "macos", target_os = "ios"))]
pub fn handle_web_content_process_terminate<R: tauri::Runtime>(webview: &tauri::Webview<R>) {
    use tauri::Manager;

    let label = webview.label().to_string();
    let now = Instant::now();
    let (state, decision) = match webview.try_state::<RendererLifecycle>() {
        Some(lifecycle) => lifecycle.record_termination(&label, now),
        None => (RendererState::default(), TerminationRecovery::Reload),
    };
    log::warn!(
        "webview-watchdog: web content process terminated for {label} (renderer generation {})",
        state.generation
    );

    if decision == TerminationRecovery::GaveUp {
        log::error!(
            "webview-watchdog: {label} renderer terminated more than {MAX_RECOVERIES} times within {}s; not reloading again",
            RECOVERY_COUNTER_RESET.as_secs()
        );
        return;
    }

    // The main window additionally goes through the heartbeat watchdog: it
    // reloads to the last-known-good route, graces the heartbeat clock so the
    // reload is not double-counted, and arms the "recovered" toast.
    if label == "main" {
        if let (Some(watchdog), Some(window)) = (
            webview.try_state::<WebviewWatchdog>(),
            webview.app_handle().get_webview_window(&label),
        ) {
            watchdog.note_recovery(now);
            if recover(&window, watchdog.last_url().as_deref()) {
                return;
            }
        }
    }
    match webview.reload() {
        Ok(()) => log::warn!("webview-watchdog: reloaded {label} after renderer termination"),
        Err(error) => {
            log::error!(
                "webview-watchdog: failed to reload {label} after renderer termination: {error}"
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TIMEOUT: Duration = Duration::from_secs(15);
    const MAX: u32 = 3;

    #[test]
    fn heartbeat_recovery_is_off_in_debug_and_on_in_release_by_default() {
        assert!(!heartbeat_recovery_enabled_for(true, None));
        assert!(heartbeat_recovery_enabled_for(false, None));
    }

    #[test]
    fn heartbeat_recovery_env_override_wins_either_way() {
        assert!(heartbeat_recovery_enabled_for(true, Some("1")));
        assert!(heartbeat_recovery_enabled_for(true, Some(" true ")));
        assert!(!heartbeat_recovery_enabled_for(false, Some("0")));
        assert!(!heartbeat_recovery_enabled_for(false, Some("false")));
    }

    #[test]
    fn heartbeat_recovery_ignores_unrecognised_override_values() {
        assert!(!heartbeat_recovery_enabled_for(true, Some("")));
        assert!(!heartbeat_recovery_enabled_for(true, Some("yes")));
        assert!(heartbeat_recovery_enabled_for(false, Some("maybe")));
    }

    #[test]
    fn slow_initial_page_load_stays_hidden() {
        // The document is still pending while Next.js compiles `/` for 61s.
        // Showing at the app-boot +8s mark exposes the unpainted black webview.
        assert_eq!(
            decide_boot_reveal(None, false, false, BOOT_REVEAL_GRACE),
            BootRevealAction::Idle
        );
    }

    #[test]
    fn only_finished_main_document_arms_boot_reveal() {
        assert!(should_arm_boot_reveal("main", true));
        assert!(!should_arm_boot_reveal("main", false));
        assert!(!should_arm_boot_reveal("pet", true));
    }

    #[test]
    fn loaded_document_stays_hidden_inside_grace() {
        assert_eq!(
            decide_boot_reveal(
                Some(BOOT_REVEAL_GRACE - Duration::from_nanos(1)),
                false,
                false,
                BOOT_REVEAL_GRACE
            ),
            BootRevealAction::Idle
        );
    }

    #[test]
    fn hidden_window_reveals_after_loaded_document_grace() {
        assert_eq!(
            decide_boot_reveal(Some(BOOT_REVEAL_GRACE), false, false, BOOT_REVEAL_GRACE),
            BootRevealAction::Reveal
        );
    }

    #[test]
    fn visible_window_never_force_reveals() {
        assert_eq!(
            decide_boot_reveal(
                Some(BOOT_REVEAL_GRACE + Duration::from_secs(1)),
                true,
                false,
                BOOT_REVEAL_GRACE
            ),
            BootRevealAction::Idle
        );
    }

    #[test]
    fn initial_load_finish_arms_only_once() {
        let wd = WebviewWatchdog::new();
        let first = Instant::now();
        assert!(wd.record_initial_load_finished(first));
        assert!(!wd.record_initial_load_finished(first + Duration::from_secs(1)));
        assert_eq!(
            wd.poll_boot_reveal(first + BOOT_REVEAL_GRACE, false),
            BootRevealAction::Reveal
        );
    }

    #[test]
    fn renderer_reveal_ack_survives_later_hide_to_tray() {
        let wd = WebviewWatchdog::new();
        let loaded = Instant::now();
        assert!(wd.record_initial_load_finished(loaded));
        wd.acknowledge_boot_reveal();

        assert_eq!(
            wd.poll_boot_reveal(loaded + BOOT_REVEAL_GRACE, false),
            BootRevealAction::Idle
        );
    }

    #[test]
    fn no_heartbeat_yet_is_idle() {
        // Renderer hasn't proven it can boot — boot path owns this window.
        assert_eq!(decide(None, true, 0, TIMEOUT, MAX), WatchdogAction::Idle);
    }

    #[test]
    fn fresh_heartbeat_is_idle() {
        let elapsed = Some(Duration::from_secs(2));
        assert_eq!(decide(elapsed, true, 0, TIMEOUT, MAX), WatchdogAction::Idle);
    }

    #[test]
    fn at_threshold_is_still_idle() {
        // `<= timeout` is alive; only strictly past it counts as dead.
        let elapsed = Some(TIMEOUT);
        assert_eq!(decide(elapsed, true, 0, TIMEOUT, MAX), WatchdogAction::Idle);
    }

    #[test]
    fn silent_past_threshold_recovers() {
        let elapsed = Some(TIMEOUT + Duration::from_secs(1));
        assert_eq!(
            decide(elapsed, true, 0, TIMEOUT, MAX),
            WatchdogAction::Recover
        );
    }

    #[test]
    fn hidden_window_never_recovers() {
        let elapsed = Some(TIMEOUT + Duration::from_secs(30));
        assert_eq!(
            decide(elapsed, false, 0, TIMEOUT, MAX),
            WatchdogAction::Idle
        );
    }

    #[test]
    fn budget_exhausted_gives_up() {
        let elapsed = Some(TIMEOUT + Duration::from_secs(1));
        assert_eq!(
            decide(elapsed, true, MAX, TIMEOUT, MAX),
            WatchdogAction::GaveUp
        );
    }

    #[test]
    fn last_recovery_in_budget_still_recovers() {
        let elapsed = Some(TIMEOUT + Duration::from_secs(1));
        assert_eq!(
            decide(elapsed, true, MAX - 1, TIMEOUT, MAX),
            WatchdogAction::Recover
        );
    }

    #[test]
    fn heartbeat_records_url_and_beat() {
        let wd = WebviewWatchdog::new();
        let now = Instant::now();
        wd.record_heartbeat(Some("tauri://localhost/chat".into()), now);
        assert_eq!(wd.last_url().as_deref(), Some("tauri://localhost/chat"));
        // A beat just landed, so a poll right now is idle.
        assert_eq!(wd.poll(now, true), WatchdogAction::Idle);
    }

    #[test]
    fn empty_url_does_not_overwrite_last_good() {
        let wd = WebviewWatchdog::new();
        let now = Instant::now();
        wd.record_heartbeat(Some("tauri://localhost/x".into()), now);
        wd.record_heartbeat(Some(String::new()), now);
        wd.record_heartbeat(None, now);
        assert_eq!(wd.last_url().as_deref(), Some("tauri://localhost/x"));
    }

    #[test]
    fn poll_recovers_after_silence() {
        let wd = WebviewWatchdog::new();
        let start = Instant::now();
        wd.record_heartbeat(Some("tauri://localhost/".into()), start);
        let later = start + HEARTBEAT_TIMEOUT + Duration::from_secs(2);
        assert_eq!(wd.poll(later, true), WatchdogAction::Recover);
    }

    #[test]
    fn note_recovery_bumps_budget_and_graces_clock() {
        let wd = WebviewWatchdog::new();
        let start = Instant::now();
        wd.record_heartbeat(Some("tauri://localhost/".into()), start);
        let dead = start + HEARTBEAT_TIMEOUT + Duration::from_secs(2);
        assert_eq!(wd.poll(dead, true), WatchdogAction::Recover);
        wd.note_recovery(dead);
        // Immediately after recovery the clock is graced — the reloaded page
        // gets a full timeout to come alive, so the next poll is idle.
        assert_eq!(wd.poll(dead, true), WatchdogAction::Idle);
        // Still dead a full timeout later → recover again (budget now 1).
        let dead2 = dead + HEARTBEAT_TIMEOUT + Duration::from_secs(2);
        assert_eq!(wd.poll(dead2, true), WatchdogAction::Recover);
    }

    #[test]
    fn budget_gives_up_after_max_recoveries() {
        let wd = WebviewWatchdog::new();
        let mut clock = Instant::now();
        wd.record_heartbeat(Some("tauri://localhost/".into()), clock);
        for _ in 0..MAX_RECOVERIES {
            clock += HEARTBEAT_TIMEOUT + Duration::from_secs(2);
            assert_eq!(wd.poll(clock, true), WatchdogAction::Recover);
            wd.note_recovery(clock);
        }
        clock += HEARTBEAT_TIMEOUT + Duration::from_secs(2);
        assert_eq!(wd.poll(clock, true), WatchdogAction::GaveUp);
    }

    #[test]
    fn sustained_life_resets_budget() {
        let wd = WebviewWatchdog::new();
        let start = Instant::now();
        wd.record_heartbeat(Some("tauri://localhost/".into()), start);
        let dead = start + HEARTBEAT_TIMEOUT + Duration::from_secs(2);
        assert_eq!(wd.poll(dead, true), WatchdogAction::Recover);
        wd.note_recovery(dead);
        // Page comes back and beats steadily; after the reset window the budget
        // clears, so a fresh, unrelated crash later gets the full allowance.
        let healthy = dead + RECOVERY_COUNTER_RESET + Duration::from_secs(1);
        wd.record_heartbeat(Some("tauri://localhost/".into()), healthy);
        let dead_again = healthy + HEARTBEAT_TIMEOUT + Duration::from_secs(2);
        assert_eq!(wd.poll(dead_again, true), WatchdogAction::Recover);
    }

    #[test]
    fn recovery_notice_is_one_shot() {
        let wd = WebviewWatchdog::new();
        assert!(!wd.take_recovery_notice());
        wd.note_recovery(Instant::now());
        assert!(wd.take_recovery_notice());
        assert!(!wd.take_recovery_notice());
    }

    #[test]
    fn gave_up_log_latches_once() {
        let wd = WebviewWatchdog::new();
        assert!(wd.mark_gave_up_logged());
        assert!(!wd.mark_gave_up_logged());
    }

    #[test]
    fn termination_budget_truth_table() {
        assert_eq!(
            decide_termination_recovery(1, MAX),
            TerminationRecovery::Reload
        );
        assert_eq!(
            decide_termination_recovery(3, MAX),
            TerminationRecovery::Reload
        );
        assert_eq!(
            decide_termination_recovery(4, MAX),
            TerminationRecovery::GaveUp
        );
    }

    #[test]
    fn termination_bumps_generation_and_awaits_reload() {
        let lifecycle = RendererLifecycle::new();
        assert_eq!(lifecycle.state("main"), RendererState::default());

        let (state, decision) = lifecycle.record_termination("main", Instant::now());
        assert_eq!(
            state,
            RendererState {
                generation: 1,
                awaiting_load: true
            }
        );
        assert_eq!(decision, TerminationRecovery::Reload);

        lifecycle.record_page_load("main");
        assert_eq!(
            lifecycle.state("main"),
            RendererState {
                generation: 1,
                awaiting_load: false
            }
        );
        // Other webviews are tracked independently.
        assert_eq!(lifecycle.state("pet"), RendererState::default());
    }

    #[test]
    fn page_load_without_termination_is_a_no_op() {
        let lifecycle = RendererLifecycle::new();
        lifecycle.record_page_load("main");
        assert!(lifecycle.snapshot().is_empty());
    }

    #[test]
    fn repeated_terminations_exhaust_then_reset_the_reload_budget() {
        let lifecycle = RendererLifecycle::new();
        let start = Instant::now();
        for offset in 0..MAX {
            let (_, decision) =
                lifecycle.record_termination("main", start + Duration::from_secs(offset as u64));
            assert_eq!(decision, TerminationRecovery::Reload);
        }
        let (state, decision) =
            lifecycle.record_termination("main", start + Duration::from_secs(5));
        assert_eq!(decision, TerminationRecovery::GaveUp);
        assert_eq!(state.generation, 4);

        let later = start + RECOVERY_COUNTER_RESET + Duration::from_secs(10);
        let (_, decision) = lifecycle.record_termination("main", later);
        assert_eq!(decision, TerminationRecovery::Reload);
    }

    #[test]
    fn snapshot_lists_known_webviews_in_label_order() {
        let lifecycle = RendererLifecycle::new();
        lifecycle.record_termination("pet", Instant::now());
        lifecycle.record_termination("main", Instant::now());
        let labels: Vec<_> = lifecycle.snapshot().into_keys().collect();
        assert_eq!(labels, vec!["main".to_string(), "pet".to_string()]);
    }

    #[test]
    fn renderer_state_serializes_camel_case() {
        let json = serde_json::to_value(RendererState {
            generation: 2,
            awaiting_load: true,
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "generation": 2, "awaitingLoad": true })
        );
    }

    #[tokio::test]
    async fn wait_for_termination_resolves_only_after_a_newer_generation() {
        let lifecycle = RendererLifecycle::new();
        let waiter = {
            let lifecycle = lifecycle.clone();
            tokio::spawn(async move { lifecycle.wait_for_termination("main", 0).await })
        };
        tokio::task::yield_now().await;
        assert!(!waiter.is_finished());

        lifecycle.record_termination("pet", Instant::now());
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(
            !waiter.is_finished(),
            "another webview's crash must not wake main"
        );

        lifecycle.record_termination("main", Instant::now());
        tokio::time::timeout(Duration::from_secs(2), waiter)
            .await
            .expect("waiter resolves after termination")
            .unwrap();
    }

    #[tokio::test]
    async fn wait_until_loaded_returns_when_the_replacement_renderer_loads() {
        let lifecycle = RendererLifecycle::new();
        assert!(
            !lifecycle
                .wait_until_loaded("main", Duration::from_millis(10))
                .await
                .awaiting_load
        );

        lifecycle.record_termination("main", Instant::now());
        let waiter = {
            let lifecycle = lifecycle.clone();
            tokio::spawn(async move {
                lifecycle
                    .wait_until_loaded("main", Duration::from_secs(5))
                    .await
            })
        };
        tokio::task::yield_now().await;
        lifecycle.record_page_load("main");
        let state = tokio::time::timeout(Duration::from_secs(2), waiter)
            .await
            .expect("waiter resolves after page load")
            .unwrap();
        assert_eq!(
            state,
            RendererState {
                generation: 1,
                awaiting_load: false
            }
        );
    }

    #[tokio::test]
    async fn wait_until_loaded_times_out_while_still_awaiting() {
        let lifecycle = RendererLifecycle::new();
        lifecycle.record_termination("main", Instant::now());
        let state = lifecycle
            .wait_until_loaded("main", Duration::from_millis(30))
            .await;
        assert!(state.awaiting_load);
    }

    #[test]
    fn budget_reset_rearms_give_up_log() {
        let wd = WebviewWatchdog::new();
        let start = Instant::now();
        wd.mark_gave_up_logged();
        wd.note_recovery(start);
        let healthy = start + RECOVERY_COUNTER_RESET + Duration::from_secs(1);
        wd.record_heartbeat(Some("tauri://localhost/".into()), healthy);
        // After the budget resets we may warn again on a future give-up.
        assert!(wd.mark_gave_up_logged());
    }
}
