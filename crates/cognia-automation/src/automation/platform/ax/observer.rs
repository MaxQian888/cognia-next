//! macOS `AXObserver` for desktop text-selection activity.
//!
//! Fills the `subscribe_events` hole on macOS, which until now returned
//! `UnsupportedPlatform`. Two notifications are watched —
//! `AXSelectedTextChanged` and `AXFocusedUIElementChanged` — and each one is
//! fanned out twice: onto the in-process [`selection_events`] bus (so the
//! selection toolbar can stop doing an AX round-trip on every single click),
//! and onto the Tauri event bus (so a workflow desktop-event trigger sees the
//! same `text-selection-changed` kind Windows UIA already emits).
//!
//! # Why a dedicated thread with a CFRunLoop
//!
//! `AXObserverGetRunLoopSource` has to be attached to a live run loop, and the
//! only run loop we could otherwise borrow is the app's main thread — where a
//! chatty observer would compete with UI work. `input_monitor/hook_mac.rs`
//! solved the identical problem for its `CGEventTap`, so this deliberately
//! mirrors that structure (named thread, run loop, `Drop` stops and joins)
//! rather than inventing a second shape.
//!
//! # Why the frontmost pid is polled
//!
//! `AXObserverCreate` is per-process: an observer registered against Safari
//! hears nothing when the user switches to Notes. Rather than register against
//! every running application — hundreds of observers, most of them never
//! firing — the thread tracks the frontmost application and re-targets when it
//! changes. `run_in_mode` gives that for free while a registration is live: it
//! services observer callbacks for one interval and then returns, so the poll
//! is the loop itself and no `CFRunLoopTimer` is needed. With no source
//! scheduled (the frontmost app refused, or none resolved yet) `run_in_mode`
//! returns `Finished` at once, so the loop sleeps the interval itself rather
//! than spin; and an application that refused is only retried after
//! [`REFUSED_RETRY`], not on every tick.
//!
//! # Failure is always local
//!
//! Sandboxed apps, apps with no accessibility server, and apps that simply
//! refuse the registration are normal. Every failure path here logs at debug
//! and leaves that one application unobserved; the toolbar's click path still
//! covers it. Nothing in this module may turn a single uncooperative app into
//! a feature-wide error.

use std::ffi::c_void;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::channel;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use objc2_application_services::{AXError, AXObserver, AXUIElement};
use objc2_core_foundation::{
    kCFRunLoopDefaultMode, CFRetained, CFRunLoop, CFRunLoopMode, CFRunLoopRunResult,
    CFRunLoopSource, CFString,
};

use super::raw::{self, AxElement};
use crate::automation::events::{emit_uia_event, UiaEventPayload};
use crate::automation::selection_events::{self, SelectionSignal, SelectionSignalKind};

/// How often the frontmost application is re-checked. Also the run loop's
/// service quantum, so observer callbacks are delivered continuously and only
/// the *re-targeting* is coarse. 400ms is well under the time it takes a human
/// to switch apps and select something.
const FOCUS_POLL: Duration = Duration::from_millis(400);

/// How long an application that refused registration is left alone before the
/// next attempt. Each attempt re-activates web accessibility in that app (a
/// Chromium tree rebuild), so it must not happen every poll; but an app that
/// just launched may only be missing its AX server for a moment.
const REFUSED_RETRY: Duration = Duration::from_secs(5);

/// Cap on a single AX message to an observed application.
///
/// Without it, one hung app blocks the run loop and every *other* app's
/// selection events stop arriving. 0.25s is generous for an attribute read and
/// short enough that a wedged app costs at most one poll interval.
const AX_MESSAGING_TIMEOUT_SECONDS: f32 = 0.25;

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// `kAXSelectedTextChangedNotification`. The AX notification names are C
/// `#define`s in `AXNotificationConstants.h`, so no binding exports them; the
/// literals are pinned to Apple's spelling by
/// `notification_names_match_the_ax_headers`.
const SELECTED_TEXT_CHANGED: &str = "AXSelectedTextChanged";

/// `kAXFocusedUIElementChangedNotification`.
const FOCUSED_UI_ELEMENT_CHANGED: &str = "AXFocusedUIElementChanged";

/// The notifications every registration subscribes to.
const NOTIFICATIONS: [&str; 2] = [SELECTED_TEXT_CHANGED, FOCUSED_UI_ELEMENT_CHANGED];

/// Which notification fired, mapped off the CFString name.
///
/// Split out as a pure function so the mapping is unit-testable without a live
/// accessibility server.
pub(crate) fn signal_kind_for(notification: &str) -> Option<SelectionSignalKind> {
    match notification {
        SELECTED_TEXT_CHANGED => Some(SelectionSignalKind::SelectionChanged),
        FOCUSED_UI_ELEMENT_CHANGED => Some(SelectionSignalKind::FocusChanged),
        _ => None,
    }
}

/// `AXObserverGetRunLoopSource`, declared here rather than through the binding:
/// the binding's wrapper panics on a null source, and an observer that cannot
/// produce one is one more uncooperative application, not a reason to take the
/// observer thread down.
fn observer_run_loop_source(observer: &AXObserver) -> Option<CFRetained<CFRunLoopSource>> {
    extern "C-unwind" {
        fn AXObserverGetRunLoopSource(observer: &AXObserver) -> Option<NonNull<CFRunLoopSource>>;
    }
    // SAFETY: valid observer. The source follows the Get rule, so it is
    // retained here for as long as the registration holds it.
    unsafe { AXObserverGetRunLoopSource(observer).map(|source| CFRetained::retain(source)) }
}

/// The run loop mode every observer source is scheduled in and serviced from.
fn default_mode() -> Option<&'static CFRunLoopMode> {
    // SAFETY: an immutable framework constant.
    unsafe { kCFRunLoopDefaultMode }
}

/// Whether a pid change should cause a re-target. Pure half of the poll loop.
pub(crate) fn should_retarget(current: Option<u32>, focused: Option<u32>) -> bool {
    match focused {
        // Never tear down a working registration just because the frontmost
        // app could not be resolved for one tick (happens during Space
        // switches and while a menu is tracking).
        None => false,
        Some(next) => current != Some(next),
    }
}

/// Whether a registration attempt against `pid` is due, given the last refusal.
/// Pure half of the retry backoff.
pub(crate) fn attempt_due(pid: u32, refused: Option<(u32, Instant)>, now: Instant) -> bool {
    match refused {
        Some((refused_pid, at)) if refused_pid == pid => {
            now.saturating_duration_since(at) >= REFUSED_RETRY
        }
        _ => true,
    }
}

/// The AX observer registered against one application.
///
/// `Drop` unschedules the source and removes both notifications; the retained
/// handles release the observer and the source after that, so re-targeting is
/// just an assignment.
struct AppObserver {
    observer: CFRetained<AXObserver>,
    app: AxElement,
    source: CFRetained<CFRunLoopSource>,
    run_loop: CFRetained<CFRunLoop>,
    pid: u32,
}

impl AppObserver {
    /// Register against `pid`. Returns `None` for any application that will not
    /// cooperate — the caller treats that as "this app uses the click path".
    fn install(pid: u32, run_loop: &CFRetained<CFRunLoop>, context: *mut c_void) -> Option<Self> {
        let mut observer: *mut AXObserver = std::ptr::null_mut();
        // SAFETY: `observer` is a valid out-parameter; on success it holds a
        // +1 observer, adopted below.
        let err = unsafe {
            AXObserver::create(
                pid as i32,
                Some(on_ax_notification),
                NonNull::from(&mut observer),
            )
        };
        if err != AXError::Success {
            log::debug!(
                "ax observer: AXObserverCreate failed for pid {pid} (err {})",
                err.0
            );
            return None;
        }
        let Some(observer) = NonNull::new(observer) else {
            log::debug!("ax observer: AXObserverCreate returned no observer for pid {pid}");
            return None;
        };
        let observer = unsafe { CFRetained::from_raw(observer) };

        let app = AxElement::application(pid);
        raw::set_messaging_timeout(&app, AX_MESSAGING_TIMEOUT_SECONDS);
        // Chromium / WebKit / Electron publish no web-content accessibility —
        // and therefore post no selection notifications — until an assistive
        // client asks for it. Without this, selecting text on a web page is
        // silent and every browser falls back to the click path.
        raw::activate_web_a11y(&app);

        let mut added = false;
        for notification in NOTIFICATIONS {
            let name = CFString::from_str(notification);
            // SAFETY: valid observer and element; `context` outlives every
            // registration (the observer thread reclaims it only after the
            // last `AppObserver` is dropped).
            let err = unsafe { observer.add_notification(app.as_ax(), &name, context) };
            if err == AXError::Success {
                added = true;
            } else {
                log::debug!(
                    "ax observer: {notification} not available for pid {pid} (err {})",
                    err.0
                );
            }
        }
        if !added {
            // Dropping `observer` releases it; nothing was registered.
            return None;
        }

        let Some(source) = observer_run_loop_source(&observer) else {
            log::debug!("ax observer: no run loop source for pid {pid}");
            return None;
        };
        run_loop.add_source(Some(&source), default_mode());

        Some(Self {
            observer,
            app,
            source,
            run_loop: run_loop.clone(),
            pid,
        })
    }
}

impl Drop for AppObserver {
    fn drop(&mut self) {
        self.run_loop
            .remove_source(Some(&self.source), default_mode());
        for notification in NOTIFICATIONS {
            let name = CFString::from_str(notification);
            // SAFETY: valid observer and element. Removing a notification that
            // failed to register returns an error, which is fine to ignore.
            let _ = unsafe { self.observer.remove_notification(self.app.as_ax(), &name) };
        }
        log::debug!("ax observer: released pid {}", self.pid);
    }
}

/// Handed to every registration as `refcon`; owned by the observer thread and
/// reclaimed once the run loop returns.
struct ObserverContext {
    subscription_id: u64,
}

/// The AX notification callback.
///
/// Runs on the observer thread's run loop and must stay cheap: two attribute
/// reads and a non-blocking publish. Reading the selected *text* here would put
/// every keystroke in every text field on a broadcast channel; consumers fetch
/// the body later, once, through the gated `read_text_selection` path.
///
/// The binding's callback ABI is `C-unwind`, so a panic here would unwind into
/// the CF run loop. It is caught and logged instead: one bad notification must
/// not take down the observer thread (or the process).
unsafe extern "C-unwind" fn on_ax_notification(
    _observer: NonNull<AXObserver>,
    element: NonNull<AXUIElement>,
    notification: NonNull<CFString>,
    refcon: *mut c_void,
) {
    if refcon.is_null() {
        return;
    }
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        // SAFETY: `refcon` is the `ObserverContext` every registration was
        // given, alive until the thread reclaims it after the last removal;
        // `element` and `notification` are valid for the callback's duration.
        let context = unsafe { &*(refcon as *const ObserverContext) };
        let name = unsafe { notification.as_ref() }.to_string();
        let element = unsafe { AxElement::retain_borrowed(element) };
        handle_notification(context, &name, &element);
    }));
    if outcome.is_err() {
        log::warn!("ax observer: notification handler panicked; event dropped");
    }
}

fn handle_notification(context: &ObserverContext, name: &str, element: &AxElement) {
    let Some(kind) = signal_kind_for(name) else {
        return;
    };

    // A secure text field reports "the selection is gone" rather than its size.
    // Nothing downstream should be tempted to go read that element's contents.
    let secure = element
        .subrole()
        .is_some_and(|subrole| subrole == "AXSecureTextField");
    let selected_len = if secure {
        0
    } else {
        raw::selected_text_range_length(element).unwrap_or(0)
    };
    let pid = raw::element_pid(element);

    selection_events::publish(SelectionSignal {
        kind,
        pid,
        selected_len,
        at_ms: now_ms(),
    });

    emit_uia_event(UiaEventPayload {
        subscription_id: context.subscription_id,
        kind: match kind {
            SelectionSignalKind::SelectionChanged => "text-selection-changed".into(),
            SelectionSignalKind::FocusChanged => "focus-changed".into(),
        },
        name: None,
        control_type: element.role(),
        process_id: pid,
        property: None,
        structure_change_type: None,
        runtime_id: None,
        at: now_ms().max(0) as u64,
    });
}

/// Owns the observer thread. Dropping it stops and joins.
pub(crate) struct AxObserverHandle {
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

impl AxObserverHandle {
    pub(crate) fn install(subscription_id: u64) -> Result<Self, String> {
        if !raw::is_trusted() {
            return Err(
                "macOS Accessibility permission not granted — enable Cognia in \
                        System Settings › Privacy & Security › Accessibility, then retry"
                    .into(),
            );
        }
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = stop.clone();
        let (ready_tx, ready_rx) = channel::<Result<(), String>>();

        let join = thread::Builder::new()
            .name("ax-selection-observer".into())
            .spawn(move || {
                let Some(run_loop) = CFRunLoop::current() else {
                    let _ = ready_tx.send(Err("ax observer: no run loop for this thread".into()));
                    return;
                };
                // Leaked for the lifetime of the thread and reclaimed below;
                // every registration holds this pointer as its `refcon`.
                let context = Box::into_raw(Box::new(ObserverContext { subscription_id }));
                let _ = ready_tx.send(Ok(()));

                let mut current: Option<AppObserver> = None;
                let mut refused: Option<(u32, Instant)> = None;
                while !thread_stop.load(Ordering::SeqCst) {
                    let focused = raw::system_wide_focused_pid();
                    if should_retarget(current.as_ref().map(|o| o.pid), focused) {
                        if let Some(pid) = focused {
                            let now = Instant::now();
                            if attempt_due(pid, refused, now) {
                                // Drop first: the old registration must be gone
                                // before the new one is added, or a fast app
                                // switch leaks.
                                drop(current.take());
                                current = AppObserver::install(pid, &run_loop, context.cast());
                                refused = current.is_none().then_some((pid, now));
                            } else {
                                // Still inside the refusal backoff: the user is
                                // in an app we cannot observe, so stop hearing
                                // the one they left.
                                current = None;
                            }
                        }
                    }
                    // Services observer callbacks for one interval, then
                    // returns so the pid can be re-checked. This IS the poll —
                    // unless no source is scheduled, when it returns at once.
                    let result =
                        CFRunLoop::run_in_mode(default_mode(), FOCUS_POLL.as_secs_f64(), false);
                    if result == CFRunLoopRunResult::Finished {
                        thread::sleep(FOCUS_POLL);
                    }
                }

                drop(current);
                // SAFETY: no registration holds `context` any more — the only
                // ones that did were dropped on the line above.
                unsafe { drop(Box::from_raw(context)) };
            })
            .map_err(|error| format!("spawn ax observer thread failed: {error}"))?;

        match ready_rx.recv() {
            Ok(Ok(())) => Ok(Self {
                stop,
                join: Some(join),
            }),
            Ok(Err(error)) => {
                let _ = join.join();
                Err(error)
            }
            Err(error) => Err(format!("ax observer thread exited before ready: {error}")),
        }
    }
}

impl Drop for AxObserverHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(join) = self.join.take() {
            // Waits at most one `FOCUS_POLL` — `run_in_mode` returns on its own
            // rather than needing `CFRunLoopStop` from another thread.
            let _ = join.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notification_names_match_the_ax_headers() {
        // `AXNotificationConstants.h`:
        //   #define kAXSelectedTextChangedNotification CFSTR("AXSelectedTextChanged")
        //   #define kAXFocusedUIElementChangedNotification CFSTR("AXFocusedUIElementChanged")
        assert_eq!(SELECTED_TEXT_CHANGED, "AXSelectedTextChanged");
        assert_eq!(FOCUSED_UI_ELEMENT_CHANGED, "AXFocusedUIElementChanged");
        assert_eq!(
            NOTIFICATIONS,
            [SELECTED_TEXT_CHANGED, FOCUSED_UI_ELEMENT_CHANGED]
        );
    }

    #[test]
    fn maps_only_the_two_notifications_it_registers_for() {
        assert_eq!(
            signal_kind_for(SELECTED_TEXT_CHANGED),
            Some(SelectionSignalKind::SelectionChanged)
        );
        assert_eq!(
            signal_kind_for(FOCUSED_UI_ELEMENT_CHANGED),
            Some(SelectionSignalKind::FocusChanged)
        );
        assert_eq!(signal_kind_for("AXValueChanged"), None);
        assert_eq!(signal_kind_for(""), None);
    }

    #[test]
    fn retargets_only_when_the_frontmost_pid_actually_changes() {
        assert!(should_retarget(None, Some(42)));
        assert!(should_retarget(Some(42), Some(43)));
        assert!(!should_retarget(Some(42), Some(42)));
    }

    #[test]
    fn a_refused_app_is_retried_only_after_the_backoff() {
        let at = Instant::now();
        assert!(attempt_due(42, None, at));
        // The app that just refused waits out the backoff…
        assert!(!attempt_due(
            42,
            Some((42, at)),
            at + Duration::from_secs(1)
        ));
        assert!(attempt_due(42, Some((42, at)), at + REFUSED_RETRY));
        // …but switching to any other app is attempted at once.
        assert!(attempt_due(43, Some((42, at)), at));
    }

    #[test]
    fn an_empty_run_loop_returns_at_once_so_the_poll_must_sleep() {
        // Pins the premise behind the idle sleep: with no source scheduled,
        // `run_in_mode` does not wait out its interval.
        let started = Instant::now();
        let result = thread::spawn(|| {
            CFRunLoop::run_in_mode(default_mode(), FOCUS_POLL.as_secs_f64(), false)
        })
        .join()
        .unwrap();
        assert_eq!(result, CFRunLoopRunResult::Finished);
        assert!(started.elapsed() < FOCUS_POLL);
    }

    #[test]
    fn an_unresolvable_frontmost_app_keeps_the_current_registration() {
        // Space switches and menu tracking briefly make
        // `AXFocusedApplication` unreadable. Tearing down there would drop
        // events for an app the user never left.
        assert!(!should_retarget(Some(42), None));
        assert!(!should_retarget(None, None));
    }
}
