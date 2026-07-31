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
//! changes. `run_in_mode` gives that for free: it services observer callbacks
//! for one interval and then returns, so the poll is the loop itself and no
//! `CFRunLoopTimer` is needed.
//!
//! # Failure is always local
//!
//! Sandboxed apps, apps with no accessibility server, and apps that simply
//! refuse the registration are normal. Every failure path here logs at debug
//! and leaves that one application unobserved; the toolbar's click path still
//! covers it. Nothing in this module may turn a single uncooperative app into
//! a feature-wide error.

use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::channel;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use accessibility::{AXUIElement, AXUIElementAttributes};
use accessibility_sys::{
    kAXErrorSuccess, kAXFocusedUIElementChangedNotification, kAXSelectedTextChangedNotification,
    AXObserverAddNotification, AXObserverCreate, AXObserverGetRunLoopSource, AXObserverRef,
    AXObserverRemoveNotification, AXUIElementCreateApplication, AXUIElementRef,
};
use core_foundation::base::TCFType as TCFType010;
use core_foundation::runloop::{kCFRunLoopDefaultMode, CFRunLoop, CFRunLoopSource};
use core_foundation_0_9 as cf_ax;
use core_foundation_sys::base::CFRelease;
use core_foundation_sys::runloop::CFRunLoopSourceRef;
use core_foundation_sys::string::CFStringRef;

use cf_ax::base::TCFType;
use cf_ax::string::CFString;

use super::raw;
use crate::automation::events::{emit_uia_event, UiaEventPayload};
use crate::automation::selection_events::{self, SelectionSignal, SelectionSignalKind};

/// How often the frontmost application is re-checked. Also the run loop's
/// service quantum, so observer callbacks are delivered continuously and only
/// the *re-targeting* is coarse. 400ms is well under the time it takes a human
/// to switch apps and select something.
const FOCUS_POLL: Duration = Duration::from_millis(400);

/// Cap on a single AX message to an observed application.
///
/// Without it, one hung app blocks the run loop and every *other* app's
/// selection events stop arriving. 0.25s is generous for an attribute read and
/// short enough that a wedged app costs at most one poll interval.
const AX_MESSAGING_TIMEOUT_SECONDS: f32 = 0.25;

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Which notification fired, mapped off the CFString name.
///
/// Split out as a pure function so the mapping is unit-testable without a live
/// accessibility server.
// The arms match `accessibility_sys` constants, whose Cocoa-style names we do
// not control. They are `const`, so these are value comparisons and not
// catch-all bindings — `maps_only_the_two_notifications_it_registers_for` pins
// that by asserting the `None` arm still fires.
#[allow(non_upper_case_globals)]
pub(crate) fn signal_kind_for(notification: &str) -> Option<SelectionSignalKind> {
    match notification {
        kAXSelectedTextChangedNotification => Some(SelectionSignalKind::SelectionChanged),
        kAXFocusedUIElementChangedNotification => Some(SelectionSignalKind::FocusChanged),
        _ => None,
    }
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

/// The AX observer registered against one application.
///
/// `Drop` removes both notifications and releases the observer, so re-targeting
/// is just an assignment.
struct AppObserver {
    observer: AXObserverRef,
    app: AXUIElement,
    source: CFRunLoopSource,
    run_loop: CFRunLoop,
    pid: u32,
}

impl AppObserver {
    /// Register against `pid`. Returns `None` for any application that will not
    /// cooperate — the caller treats that as "this app uses the click path".
    fn install(pid: u32, run_loop: &CFRunLoop, context: *mut c_void) -> Option<Self> {
        let mut observer: AXObserverRef = std::ptr::null_mut();
        let err = unsafe { AXObserverCreate(pid as i32, on_ax_notification, &mut observer) };
        if err != kAXErrorSuccess || observer.is_null() {
            log::debug!("ax observer: AXObserverCreate failed for pid {pid} (err {err})");
            return None;
        }

        let app = unsafe {
            AXUIElement::wrap_under_create_rule(AXUIElementCreateApplication(pid as i32))
        };
        raw::set_messaging_timeout(&app, AX_MESSAGING_TIMEOUT_SECONDS);
        // Chromium / WebKit / Electron publish no web-content accessibility —
        // and therefore post no selection notifications — until an assistive
        // client asks for it. Without this, selecting text on a web page is
        // silent and every browser falls back to the click path.
        raw::activate_web_a11y(&app);

        let app_ref = app.as_concrete_TypeRef() as AXUIElementRef;
        let mut added = false;
        for notification in [
            kAXSelectedTextChangedNotification,
            kAXFocusedUIElementChangedNotification,
        ] {
            let name = CFString::new(notification);
            let err = unsafe {
                AXObserverAddNotification(observer, app_ref, name.as_concrete_TypeRef(), context)
            };
            if err == kAXErrorSuccess {
                added = true;
            } else {
                log::debug!("ax observer: {notification} not available for pid {pid} (err {err})");
            }
        }
        if !added {
            unsafe { CFRelease(observer.cast()) };
            return None;
        }

        let source: CFRunLoopSource = unsafe {
            let raw_source: CFRunLoopSourceRef = AXObserverGetRunLoopSource(observer);
            if raw_source.is_null() {
                CFRelease(observer.cast());
                return None;
            }
            CFRunLoopSource::wrap_under_get_rule(raw_source)
        };
        unsafe { run_loop.add_source(&source, kCFRunLoopDefaultMode) };

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
            .remove_source(&self.source, unsafe { kCFRunLoopDefaultMode });
        let app_ref = self.app.as_concrete_TypeRef() as AXUIElementRef;
        for notification in [
            kAXSelectedTextChangedNotification,
            kAXFocusedUIElementChangedNotification,
        ] {
            let name = CFString::new(notification);
            unsafe {
                AXObserverRemoveNotification(self.observer, app_ref, name.as_concrete_TypeRef());
            }
        }
        unsafe { CFRelease(self.observer.cast()) };
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
unsafe extern "C" fn on_ax_notification(
    _observer: AXObserverRef,
    element: AXUIElementRef,
    notification: CFStringRef,
    refcon: *mut c_void,
) {
    if element.is_null() || notification.is_null() || refcon.is_null() {
        return;
    }
    let context = &*(refcon as *const ObserverContext);
    let name = CFString::wrap_under_get_rule(notification).to_string();
    let Some(kind) = signal_kind_for(&name) else {
        return;
    };
    let element = AXUIElement::wrap_under_get_rule(element);

    // A secure text field reports "the selection is gone" rather than its size.
    // Nothing downstream should be tempted to go read that element's contents.
    let secure = element
        .subrole()
        .ok()
        .is_some_and(|subrole| subrole == "AXSecureTextField");
    let selected_len = if secure {
        0
    } else {
        raw::selected_text_range_length(&element).unwrap_or(0)
    };
    let pid = raw::element_pid(&element);

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
        control_type: element.role().ok().map(|role| role.to_string()),
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
                let run_loop = CFRunLoop::get_current();
                // Leaked for the lifetime of the thread and reclaimed below;
                // every registration holds this pointer as its `refcon`.
                let context = Box::into_raw(Box::new(ObserverContext { subscription_id }));
                let _ = ready_tx.send(Ok(()));

                let mut current: Option<AppObserver> = None;
                while !thread_stop.load(Ordering::SeqCst) {
                    let focused = raw::system_wide_focused_pid();
                    if should_retarget(current.as_ref().map(|o| o.pid), focused) {
                        // Drop first: the old registration must be gone before
                        // the new one is added, or a fast app switch leaks.
                        current = None;
                        if let Some(pid) = focused {
                            current = AppObserver::install(pid, &run_loop, context.cast());
                        }
                    }
                    // Services observer callbacks for one interval, then
                    // returns so the pid can be re-checked. This IS the poll.
                    CFRunLoop::run_in_mode(unsafe { kCFRunLoopDefaultMode }, FOCUS_POLL, false);
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
    fn maps_only_the_two_notifications_it_registers_for() {
        assert_eq!(
            signal_kind_for(kAXSelectedTextChangedNotification),
            Some(SelectionSignalKind::SelectionChanged)
        );
        assert_eq!(
            signal_kind_for(kAXFocusedUIElementChangedNotification),
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
    fn an_unresolvable_frontmost_app_keeps_the_current_registration() {
        // Space switches and menu tracking briefly make
        // `AXFocusedApplication` unreadable. Tearing down there would drop
        // events for an app the user never left.
        assert!(!should_retarget(Some(42), None));
        assert!(!should_retarget(None, None));
    }
}
