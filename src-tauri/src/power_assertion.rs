//! Keep the host awake while it owes someone work.
//!
//! A desktop host that accepts remote runs is useless asleep: the worker socket
//! drops, the run's lease expires, and the team sees a host that was "online"
//! thirty seconds ago and is now silently gone. Every OS exposes a way to say
//! "not now" — they just disagree about how.
//!
//! The assertion is reference counted, because two independent subsystems hold
//! it for overlapping reasons: an in-flight agent run, and an attached execution
//! worker. Releasing on the first one to finish would drop the machine mid-run
//! for the other.

use std::collections::HashMap;

use once_cell::sync::Lazy;
use parking_lot::Mutex;

/// Why the host is being held awake. One entry per holder, so an overlapping
/// hold from another subsystem cannot be released by the first one to finish.
#[derive(Clone, Debug, Eq, PartialEq, Hash, PartialOrd, Ord)]
pub enum WakeReason {
    /// An agent run is executing on this host.
    ActiveRun(String),
    /// An execution worker is attached and may be dispatched to at any moment.
    AttachedWorker(String),
}

impl WakeReason {
    fn describe(&self) -> String {
        match self {
            WakeReason::ActiveRun(id) => format!("Cognia is running agent work ({id})"),
            WakeReason::AttachedWorker(host) => {
                format!("Cognia is holding an execution worker ({host})")
            }
        }
    }
}

#[derive(Default)]
struct AssertionState {
    holders: HashMap<WakeReason, usize>,
    handle: Option<PlatformAssertion>,
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
    let needs_handle = {
        let mut state = STATE.lock();
        *state.holders.entry(reason.clone()).or_insert(0) += 1;
        state.handle.is_none()
    };
    if !needs_handle {
        return;
    }

    // Built with the lock RELEASED. `create` spawns a child process on Linux
    // and a thread it then blocks on for Windows, and `acquire` runs on a tokio
    // worker thread (`install_worker` ← `handle_worker_socket`). Holding this
    // process-global lock across that would stall every other subsystem's
    // acquire/release/`active_reasons` behind one slow fork.
    let handle = match PlatformAssertion::create(&reason.describe()) {
        Ok(handle) => handle,
        Err(error) => {
            // A host that cannot assert is still a working host — it just may
            // sleep. Failing the run over it would be worse than the nap.
            log::warn!("power assertion unavailable: {error}");
            return;
        }
    };

    let mut state = STATE.lock();
    // Two things can have happened while the lock was open: another `acquire`
    // installed its own handle, or every holder released. Either way this one
    // is surplus, and dropping it on the floor would leak the OS assertion.
    if state.handle.is_some() || state.holders.is_empty() {
        drop(state);
        handle.release();
        return;
    }
    state.handle = Some(handle);
}

/// Drop a hold. The platform assertion is released when the last one goes.
pub fn release(reason: &WakeReason) {
    let mut state = STATE.lock();
    if let Some(count) = state.holders.get_mut(reason) {
        *count = count.saturating_sub(1);
        if *count == 0 {
            state.holders.remove(reason);
        }
    }
    if state.holders.is_empty() {
        if let Some(handle) = state.handle.take() {
            handle.release();
        }
    }
}

/// Whether the host is currently being held awake, and by what.
pub fn active_reasons() -> Vec<WakeReason> {
    let mut reasons = STATE.lock().holders.keys().cloned().collect::<Vec<_>>();
    reasons.sort();
    reasons
}

#[cfg(target_os = "macos")]
mod platform {
    use core_foundation::base::TCFType;
    use core_foundation::string::{CFString, CFStringRef};

    type IOPMAssertionID = u32;
    type IOReturn = i32;
    const K_IO_RETURN_SUCCESS: IOReturn = 0;
    /// Prevent idle *system* sleep; the display may still turn off.
    const ASSERTION_TYPE: &str = "PreventUserIdleSystemSleep";
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
        pub fn create(reason: &str) -> Result<Self, String> {
            let assertion_type = CFString::new(ASSERTION_TYPE);
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

    /// `systemd-inhibit` holds a logind lock for as long as its child lives, so
    /// the child is a `sleep` we own and kill. This is the documented way to
    /// take a block lock without a D-Bus connection of our own.
    pub struct PlatformAssertion {
        child: Child,
    }

    impl PlatformAssertion {
        pub fn create(reason: &str) -> Result<Self, String> {
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
        SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED,
    };

    /// `SetThreadExecutionState` is thread-affine: the flags live on the calling
    /// thread and are dropped when it exits. The assertion therefore owns a
    /// thread that does nothing but hold them, mirroring the virtual-display
    /// keepalive controller.
    pub struct PlatformAssertion {
        stop: Sender<()>,
    }

    impl PlatformAssertion {
        pub fn create(_reason: &str) -> Result<Self, String> {
            let (stop, rx) = channel::<()>();
            let (ready, ready_rx) = channel::<Result<(), String>>();
            thread::Builder::new()
                .name("cognia-power-assertion".into())
                .spawn(move || {
                    unsafe {
                        SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED);
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
    pub struct PlatformAssertion;

    impl PlatformAssertion {
        pub fn create(_reason: &str) -> Result<Self, String> {
            Err("power assertions are not supported on this platform".to_string())
        }

        pub fn release(self) {}
    }
}

use platform::PlatformAssertion;

#[cfg(test)]
mod tests {
    use super::*;

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
    }
}
