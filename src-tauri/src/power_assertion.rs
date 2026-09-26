//! Tauri facade for the host's keep-awake assertion.
//!
//! The reference-counted assertion lives in `cognia_power` and is
//! glob-re-exported here, so `crate::power_assertion::…` paths resolve
//! unchanged (ADR-0196). The renderer's screen-hold command stays in the app.

pub use cognia_power::*;

/// Replace the set of conversations holding the screen awake. See
/// [`cognia_power::set_screen_holds`].
///
/// `async` on purpose: Tauri runs a synchronous command on the main thread, and
/// installing the platform assertion spawns a process on Linux and a thread it
/// waits on for Windows. A UI thread is the wrong place for either.
#[tauri::command]
pub async fn power_screen_holds_set(holders: Vec<String>) {
    set_screen_holds(&holders);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The command is `async` only to keep it off Tauri's main thread; the
    /// body never awaits, so a trivial executor is enough to drive it.
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

    #[test]
    fn the_screen_command_sets_the_screen_holds() {
        let _guard = ASSERTION_TEST_LOCK.lock();
        block_on(power_screen_holds_set(vec!["s_command".into()]));
        assert!(active_reasons().contains(&WakeReason::ScreenAwake("s_command".into())));
        block_on(power_screen_holds_set(vec![]));
        assert!(!active_reasons().contains(&WakeReason::ScreenAwake("s_command".into())));
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
}
