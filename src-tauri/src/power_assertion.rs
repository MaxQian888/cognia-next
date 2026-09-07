//! Keep the host awake while it owes someone work.
//!
//! A desktop host that accepts remote runs is useless asleep: the worker socket
//! drops, the run's lease expires, and the team sees a host that was "online"
//! thirty seconds ago and is now silently gone. Every OS exposes a way to say
//! "not now" — they just disagree about how.
//!
//! The assertion is reference counted, because independent subsystems hold it
//! for overlapping reasons: an in-flight agent run, an attached execution
//! worker, and a conversation whose power policy asks for the screen to stay
//! lit. Releasing on the first one to finish would drop the machine mid-run for
//! the others.
//!
//! Holders also disagree about how FAR the promise reaches — "don't sleep" and
//! "don't even dim the screen" are different assertions on every OS — so each
//! holder carries a [`WakeLevel`] and the installed handle tracks the maximum.

use std::collections::HashMap;

use once_cell::sync::Lazy;
use parking_lot::Mutex;

/// How far the hold reaches.
///
/// The OS treats "keep computing" and "keep the panel lit" as two different
/// promises, and they are two different *user intents*: a turn that has to
/// survive the lid timer wants the first, a turn the user is watching from
/// across the room wants the second. Ordered — `Display` implies `System`, so
/// the effective level of a set of holders is simply the maximum.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash, PartialOrd, Ord)]
pub enum WakeLevel {
    /// The machine must not idle-sleep. The display may still turn off.
    System,
    /// The display must stay lit as well.
    Display,
}

/// Why the host is being held awake. One entry per holder, so an overlapping
/// hold from another subsystem cannot be released by the first one to finish.
#[derive(Clone, Debug, Eq, PartialEq, Hash, PartialOrd, Ord)]
pub enum WakeReason {
    /// An agent run is executing on this host.
    ActiveRun(String),
    /// An execution worker is attached and may be dispatched to at any moment.
    AttachedWorker(String),
    /// A conversation is configured to keep the screen lit while it runs
    /// (`SessionPowerPolicy = "keepScreenOn"`). The renderer owns this hold:
    /// it knows the per-session policy and the turn's status edges, and it is
    /// the same coordinator that drives the browser `navigator.wakeLock` on
    /// every non-desktop shell.
    ScreenAwake(String),
}

impl WakeReason {
    fn describe(&self) -> String {
        match self {
            WakeReason::ActiveRun(id) => format!("Cognia is running agent work ({id})"),
            WakeReason::AttachedWorker(host) => {
                format!("Cognia is holding an execution worker ({host})")
            }
            WakeReason::ScreenAwake(id) => {
                format!("Cognia is keeping the screen on for a conversation ({id})")
            }
        }
    }

    /// How far this holder's promise reaches.
    pub fn level(&self) -> WakeLevel {
        match self {
            WakeReason::ActiveRun(_) | WakeReason::AttachedWorker(_) => WakeLevel::System,
            WakeReason::ScreenAwake(_) => WakeLevel::Display,
        }
    }
}

struct InstalledAssertion {
    level: WakeLevel,
    assertion: PlatformAssertion,
}

#[derive(Default)]
struct AssertionState {
    holders: HashMap<WakeReason, usize>,
    handle: Option<InstalledAssertion>,
}

/// The level the current holders need, or `None` when nobody holds.
fn desired_level(holders: &HashMap<WakeReason, usize>) -> Option<WakeLevel> {
    holders.keys().map(WakeReason::level).max()
}

/// The name the OS shows for a hold at `level` — the lowest-sorting holder that
/// actually needs that level, so `pmset -g assertions` / logind name a real
/// reason instead of a generic label.
fn describe_at(holders: &HashMap<WakeReason, usize>, level: WakeLevel) -> String {
    holders
        .keys()
        .filter(|reason| reason.level() == level)
        .min()
        .map(WakeReason::describe)
        .unwrap_or_else(|| "Cognia is busy".to_string())
}

static STATE: Lazy<Mutex<AssertionState>> = Lazy::new(|| Mutex::new(AssertionState::default()));

/// Serializes tests that observe the process-global assertion state.
///
/// The OS grants one wake lock per process, not one per subsystem, so the state
/// here is deliberately global. Cargo runs tests in parallel threads, and this
/// state is mutated as a *side effect* of unrelated code — `install_worker` and
/// `remove_worker` in `ws_worker` take and drop a hold — so any test that
/// asserts on `active_reasons()` must take this, and so must any test that
/// drives something which holds. Without it the two suites see each other's
/// holders and fail intermittently.
#[cfg(test)]
pub(crate) static ASSERTION_TEST_LOCK: Mutex<()> = Mutex::new(());

/// Take a hold. Idempotent per reason; the same reason twice needs two releases.
pub fn acquire(reason: WakeReason) {
    {
        let mut state = STATE.lock();
        *state.holders.entry(reason).or_insert(0) += 1;
    }
    reconcile();
}

/// Drop a hold. The platform assertion is released when the last one goes, and
/// downgraded when the last holder that needed the *display* goes.
pub fn release(reason: &WakeReason) {
    {
        let mut state = STATE.lock();
        if let Some(count) = state.holders.get_mut(reason) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                state.holders.remove(reason);
            }
        }
    }
    reconcile();
}

/// Bring the installed OS assertion in line with the holders.
///
/// Every platform handle is built and released with the lock RELEASED. `create`
/// spawns a child process on Linux and a thread it then blocks on for Windows,
/// and this runs on tokio worker threads (`install_worker` ←
/// `handle_worker_socket`); holding this process-global lock across that would
/// stall every other subsystem's acquire/release behind one slow fork.
///
/// That open window is why this loops: another thread can acquire or release
/// while a handle is being built, so the plan is re-checked before the handle
/// is installed and re-planned when it no longer matches.
fn reconcile() {
    loop {
        // Plan under the lock. When anything must change, the outgoing handle
        // leaves with the plan — leaving it installed would make the
        // "someone else already installed one" check below reject our own
        // replacement forever.
        let (retired, target) = {
            let mut state = STATE.lock();
            let desired = desired_level(&state.holders);
            let current = state.handle.as_ref().map(|installed| installed.level);
            if desired == current {
                return;
            }
            let name = desired.map(|level| describe_at(&state.holders, level));
            (state.handle.take(), desired.zip(name))
        };
        if let Some(installed) = retired {
            installed.assertion.release();
        }
        let Some((level, name)) = target else {
            // Nobody holds any more. A later acquire re-enters here.
            return;
        };

        let assertion = match PlatformAssertion::create(&name, level) {
            Ok(assertion) => assertion,
            Err(error) => {
                // A host that cannot assert is still a working host — it just
                // may sleep. Failing the run over it would be worse than the nap.
                log::warn!("power assertion unavailable: {error}");
                return;
            }
        };

        let mut state = STATE.lock();
        if state.handle.is_some() || desired_level(&state.holders) != Some(level) {
            drop(state);
            assertion.release();
            continue;
        }
        state.handle = Some(InstalledAssertion { level, assertion });
        return;
    }
}

/// Replace the set of conversations holding the screen awake.
///
/// A whole set rather than acquire/release pairs, because the renderer's
/// coordinator (`lib/power/screen-wake-lock.ts`) knows the desired set and
/// nothing else does. Pairs strand a hold whenever the webview goes away
/// between them: a reload mid-run, or a crash, and the display stays pinned for
/// the life of the process with no conversation to blame. Replacing the set
/// makes the first call after any reload the repair.
///
/// Only `ScreenAwake` holders are touched. The run and worker holds belong to
/// Rust subsystems that outlive any webview.
///
/// `async` on purpose: Tauri runs a synchronous command on the main thread, and
/// installing the platform assertion spawns a process on Linux and a thread it
/// waits on for Windows. A UI thread is the wrong place for either.
#[tauri::command]
pub async fn power_screen_holds_set(holders: Vec<String>) {
    set_screen_holds(&holders);
}

/// The body of [`power_screen_holds_set`], callable from tests.
fn set_screen_holds(holders: &[String]) {
    let desired: std::collections::HashSet<&str> = holders.iter().map(String::as_str).collect();
    {
        let mut state = STATE.lock();
        state.holders.retain(|reason, _| match reason {
            WakeReason::ScreenAwake(id) => desired.contains(id.as_str()),
            _ => true,
        });
        for holder in &desired {
            state
                .holders
                .entry(WakeReason::ScreenAwake((*holder).to_string()))
                .or_insert(1);
        }
    }
    reconcile();
}

/// Whether the host is currently being held awake, and by what.
#[cfg(test)]
pub fn active_reasons() -> Vec<WakeReason> {
    let mut reasons = STATE.lock().holders.keys().cloned().collect::<Vec<_>>();
    reasons.sort();
    reasons
}

/// The level the holders currently ask for. `None` when nothing holds.
#[cfg(test)]
pub fn active_level() -> Option<WakeLevel> {
    desired_level(&STATE.lock().holders)
}

#[cfg(target_os = "macos")]
mod platform {
    use core_foundation::base::TCFType;
    use core_foundation::string::{CFString, CFStringRef};

    use super::WakeLevel;

    type IOPMAssertionID = u32;
    type IOReturn = i32;
    const K_IO_RETURN_SUCCESS: IOReturn = 0;
    /// Prevent idle *system* sleep; the display may still turn off.
    const SYSTEM_ASSERTION_TYPE: &str = "PreventUserIdleSystemSleep";
    /// Prevent idle *display* sleep. Implies the system one — a Mac whose
    /// screen is lit is not idle-sleeping.
    const DISPLAY_ASSERTION_TYPE: &str = "PreventUserIdleDisplaySleep";
    const ASSERTION_LEVEL_ON: u32 = 255;

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOPMAssertionCreateWithName(
            assertion_type: CFStringRef,
            assertion_level: u32,
            assertion_name: CFStringRef,
            assertion_id: *mut IOPMAssertionID,
        ) -> IOReturn;
        fn IOPMAssertionRelease(assertion_id: IOPMAssertionID) -> IOReturn;
    }

    pub struct PlatformAssertion {
        id: IOPMAssertionID,
    }

    impl PlatformAssertion {
        pub fn create(reason: &str, level: WakeLevel) -> Result<Self, String> {
            let assertion_type = CFString::new(match level {
                WakeLevel::System => SYSTEM_ASSERTION_TYPE,
                WakeLevel::Display => DISPLAY_ASSERTION_TYPE,
            });
            let name = CFString::new(reason);
            let mut id: IOPMAssertionID = 0;
            let result = unsafe {
                IOPMAssertionCreateWithName(
                    assertion_type.as_concrete_TypeRef(),
                    ASSERTION_LEVEL_ON,
                    name.as_concrete_TypeRef(),
                    &mut id,
                )
            };
            if result != K_IO_RETURN_SUCCESS {
                return Err(format!("IOPMAssertionCreateWithName failed: {result}"));
            }
            Ok(Self { id })
        }

        pub fn release(self) {
            unsafe {
                IOPMAssertionRelease(self.id);
            }
        }
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use std::process::{Child, Command, Stdio};

    use super::WakeLevel;

    /// `systemd-inhibit` holds a logind lock for as long as its child lives, so
    /// the child is a `sleep` we own and kill. This is the documented way to
    /// take a block lock without a D-Bus connection of our own.
    ///
    /// logind has no "display" lock of its own: `idle` is the closest thing,
    /// and whether it also holds the screen back depends on the desktop
    /// environment honouring the inhibitor (GNOME and KDE do; a bare X session
    /// with its own screensaver may not). Best effort, and the only lever that
    /// exists without taking a hard dependency on a session bus.
    pub struct PlatformAssertion {
        child: Child,
    }

    impl PlatformAssertion {
        // The level is deliberately unused: `sleep:idle` is already the
        // strongest lever logind offers, and asking for less at `System` would
        // only weaken the hold that has shipped since this module existed.
        pub fn create(reason: &str, _level: WakeLevel) -> Result<Self, String> {
            let child = Command::new("systemd-inhibit")
                .args([
                    "--what=sleep:idle",
                    "--who=Cognia",
                    &format!("--why={reason}"),
                    "--mode=block",
                    "sleep",
                    "infinity",
                ])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|error| format!("systemd-inhibit failed: {error}"))?;
            Ok(Self { child })
        }

        pub fn release(mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use std::sync::mpsc::{channel, Sender};
    use std::thread;

    use windows::Win32::System::Power::{
        SetThreadExecutionState, ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED,
    };

    use super::WakeLevel;

    /// `SetThreadExecutionState` is thread-affine: the flags live on the calling
    /// thread and are dropped when it exits. The assertion therefore owns a
    /// thread that does nothing but hold them, mirroring the virtual-display
    /// keepalive controller.
    pub struct PlatformAssertion {
        stop: Sender<()>,
    }

    impl PlatformAssertion {
        pub fn create(_reason: &str, level: WakeLevel) -> Result<Self, String> {
            let (stop, rx) = channel::<()>();
            let (ready, ready_rx) = channel::<Result<(), String>>();
            let flags = match level {
                WakeLevel::System => ES_CONTINUOUS | ES_SYSTEM_REQUIRED,
                WakeLevel::Display => ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED,
            };
            thread::Builder::new()
                .name("cognia-power-assertion".into())
                .spawn(move || {
                    unsafe {
                        SetThreadExecutionState(flags);
                    }
                    let _ = ready.send(Ok(()));
                    let _ = rx.recv();
                    unsafe {
                        SetThreadExecutionState(ES_CONTINUOUS);
                    }
                })
                .map_err(|error| format!("power assertion thread failed: {error}"))?;
            ready_rx
                .recv()
                .map_err(|error| format!("power assertion thread died: {error}"))??;
            Ok(Self { stop })
        }

        pub fn release(self) {
            let _ = self.stop.send(());
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
mod platform {
    use super::WakeLevel;

    pub struct PlatformAssertion;

    impl PlatformAssertion {
        pub fn create(_reason: &str, _level: WakeLevel) -> Result<Self, String> {
            Err("power assertions are not supported on this platform".to_string())
        }

        pub fn release(self) {}
    }
}

use platform::PlatformAssertion;

#[cfg(test)]
mod tests {
    use super::*;

    /// These commands are `async` only to keep them off Tauri's main thread;
    /// the bodies never await, so a trivial executor is enough to drive them.
    fn block_on<F: std::future::Future>(future: F) -> F::Output {
        use std::task::{Context, Poll, RawWaker, RawWakerVTable, Waker};
        fn noop(_: *const ()) {}
        fn clone(_: *const ()) -> RawWaker {
            RawWaker::new(std::ptr::null(), &VTABLE)
        }
        static VTABLE: RawWakerVTable = RawWakerVTable::new(clone, noop, noop, noop);
        let waker = unsafe { Waker::from_raw(clone(std::ptr::null())) };
        let mut context = Context::from_waker(&waker);
        let mut future = Box::pin(future);
        match future.as_mut().poll(&mut context) {
            Poll::Ready(value) => value,
            Poll::Pending => panic!("power wake lock command awaited something"),
        }
    }

    fn drain() {
        for reason in active_reasons() {
            while active_reasons().contains(&reason) {
                release(&reason);
            }
        }
    }

    #[test]
    fn overlapping_holders_each_need_their_own_release() {
        let _guard = ASSERTION_TEST_LOCK.lock();
        // The run and the worker hold for different reasons at overlapping
        // times. Releasing on the first one to finish would put the machine to
        // sleep while the other is still working.
        drain();
        acquire(WakeReason::ActiveRun("run-1".into()));
        acquire(WakeReason::AttachedWorker("device:a".into()));

        release(&WakeReason::ActiveRun("run-1".into()));
        assert_eq!(
            active_reasons(),
            vec![WakeReason::AttachedWorker("device:a".into())]
        );

        release(&WakeReason::AttachedWorker("device:a".into()));
        assert!(active_reasons().is_empty());
    }

    #[test]
    fn the_same_reason_twice_is_reference_counted() {
        let _guard = ASSERTION_TEST_LOCK.lock();
        drain();
        acquire(WakeReason::ActiveRun("run-2".into()));
        acquire(WakeReason::ActiveRun("run-2".into()));

        release(&WakeReason::ActiveRun("run-2".into()));
        assert_eq!(
            active_reasons(),
            vec![WakeReason::ActiveRun("run-2".into())],
            "a second holder still needs the machine awake"
        );

        release(&WakeReason::ActiveRun("run-2".into()));
        assert!(active_reasons().is_empty());
        drain();
    }

    #[test]
    fn releasing_an_unheld_reason_is_a_no_op() {
        let _guard = ASSERTION_TEST_LOCK.lock();
        drain();
        release(&WakeReason::ActiveRun("never-held".into()));
        assert!(active_reasons().is_empty());
    }

    #[test]
    fn a_screen_hold_raises_the_level_and_dropping_it_lowers_it_again() {
        let _guard = ASSERTION_TEST_LOCK.lock();
        drain();
        // A run only promises the machine keeps computing. The conversation's
        // "keep the screen on" policy promises more, and the OS needs the
        // stronger assertion for as long as that holder is around — but must
        // fall back to the cheaper one afterwards rather than pinning the
        // display lit for the rest of the turn.
        acquire(WakeReason::ActiveRun("run-3".into()));
        assert_eq!(active_level(), Some(WakeLevel::System));

        acquire(WakeReason::ScreenAwake("s_abc".into()));
        assert_eq!(active_level(), Some(WakeLevel::Display));

        release(&WakeReason::ScreenAwake("s_abc".into()));
        assert_eq!(active_level(), Some(WakeLevel::System));

        release(&WakeReason::ActiveRun("run-3".into()));
        assert_eq!(active_level(), None);
    }

    #[test]
    fn the_screen_command_replaces_the_whole_holder_set() {
        let _guard = ASSERTION_TEST_LOCK.lock();
        drain();
        block_on(power_screen_holds_set(vec!["s_one".into(), "s_two".into()]));
        assert_eq!(
            active_reasons(),
            vec![
                WakeReason::ScreenAwake("s_one".into()),
                WakeReason::ScreenAwake("s_two".into())
            ]
        );
        assert_eq!(active_level(), Some(WakeLevel::Display));

        // One conversation finishing must not drop the other's hold.
        block_on(power_screen_holds_set(vec!["s_two".into()]));
        assert_eq!(
            active_reasons(),
            vec![WakeReason::ScreenAwake("s_two".into())]
        );

        block_on(power_screen_holds_set(vec![]));
        assert!(active_reasons().is_empty());
        assert_eq!(active_level(), None);
    }

    #[test]
    fn a_replaced_set_leaves_the_run_and_worker_holds_alone() {
        let _guard = ASSERTION_TEST_LOCK.lock();
        drain();
        // A webview reload sends a fresh (often empty) set. Clearing every
        // holder there would put the machine to sleep in the middle of the run
        // the reloading window was watching.
        acquire(WakeReason::ActiveRun("run-set".into()));
        block_on(power_screen_holds_set(vec!["s_reload".into()]));
        block_on(power_screen_holds_set(vec![]));
        assert_eq!(
            active_reasons(),
            vec![WakeReason::ActiveRun("run-set".into())]
        );
        assert_eq!(active_level(), Some(WakeLevel::System));
        release(&WakeReason::ActiveRun("run-set".into()));
    }

    #[test]
    fn re_sending_the_same_set_does_not_stack_holds() {
        let _guard = ASSERTION_TEST_LOCK.lock();
        drain();
        // The coordinator re-sends on any edge it is unsure about; a second
        // send must not need a second release.
        block_on(power_screen_holds_set(vec!["s_same".into()]));
        block_on(power_screen_holds_set(vec!["s_same".into()]));
        block_on(power_screen_holds_set(vec![]));
        assert!(active_reasons().is_empty());
    }

    #[test]
    fn the_screen_commands_are_registered_with_the_tauri_invoke_handler() {
        // Registration is what makes them reachable from the renderer's power
        // coordinator; a command that only exists in this file is dead code the
        // UI silently falls back from.
        let source = include_str!("lib.rs");
        let production_source = source
            .split("#[cfg(test)]")
            .next()
            .expect("production lib.rs source");
        for command in ["power_assertion::power_screen_holds_set,"] {
            assert!(
                production_source.contains(command),
                "{command} must remain in tauri::generate_handler!"
            );
        }
    }

    #[test]
    fn reasons_describe_the_holder_for_the_os_ui() {
        // macOS lists the assertion name in `pmset -g assertions`; logind shows
        // the `--why` string. A generic label makes an unexplained awake machine
        // impossible to diagnose.
        assert!(WakeReason::ActiveRun("run-9".into())
            .describe()
            .contains("run-9"));
        assert!(WakeReason::AttachedWorker("device:z".into())
            .describe()
            .contains("device:z"));
        assert!(WakeReason::ScreenAwake("s_zz".into())
            .describe()
            .contains("s_zz"));
        // The name follows the level that is actually installed, so an OS
        // listing never blames a run for a display hold it never asked for.
        let mut holders = HashMap::new();
        holders.insert(WakeReason::ActiveRun("run-a".into()), 1usize);
        holders.insert(WakeReason::ScreenAwake("s_named".into()), 1usize);
        assert!(describe_at(&holders, WakeLevel::Display).contains("s_named"));
        assert!(describe_at(&holders, WakeLevel::System).contains("run-a"));
    }
}
