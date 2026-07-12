//! Runtime white-screen watchdog for the main webview.
//!
//! `window_recovery` + the lib.rs 8s force-show timer handle *boot-time*
//! blanking — an off-screen restore, or a renderer that never paints its first
//! frame. This module is their *runtime* counterpart: after a healthy boot the
//! webview's renderer process can crash (WebView2 `ProcessFailed`, WKWebView
//! content-process termination, GPU/OOM kills), the page can wedge on a blocked
//! main thread, or it can be navigated to a blank/broken document. In every one
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

use std::sync::Mutex;
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
/// boot (the 8s force-show owns the boot path) or one the user can't even see.
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

/// Returns (and clears) whether the page was just auto-recovered from a blank
/// screen, so the reloaded renderer can surface a toast.
#[tauri::command]
pub fn webview_take_recovery_notice(state: tauri::State<'_, WebviewWatchdog>) -> bool {
    state.take_recovery_notice()
}

#[cfg(test)]
mod tests {
    use super::*;

    const TIMEOUT: Duration = Duration::from_secs(15);
    const MAX: u32 = 3;

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
