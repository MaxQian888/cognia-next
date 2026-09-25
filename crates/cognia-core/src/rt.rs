//! Spawn onto the process's async runtime without naming Tauri (ADR-0196).
//!
//! Library crates used to call `tauri::async_runtime::spawn`, which links
//! Tauri into every crate that starts a background task. The semantics they
//! relied on are small: run on the runtime the app is using, even when called
//! from a thread that never entered it (the desktop's `setup()` runs on the
//! main thread). [`spawn`] keeps exactly that, in this order:
//!
//! 1. the runtime the calling thread is inside, if any;
//! 2. the runtime the host binary installed with [`install`] at boot — the
//!    desktop hands over the handle it gives `tauri::async_runtime::set`;
//! 3. a multi-threaded runtime built on first use, which is what
//!    `tauri::async_runtime` itself falls back to when nothing was set.

use std::future::Future;
use std::sync::OnceLock;

use tokio::runtime::{Handle, Runtime};
use tokio::task::JoinHandle;

use crate::installed::{AlreadyInstalled, Installed};

static HOST_RUNTIME: Installed<Handle> = Installed::new("cognia_core::rt::HOST_RUNTIME");
static FALLBACK: OnceLock<Runtime> = OnceLock::new();

/// Hand the host's runtime to every crate that spawns through this module.
/// Call once, before anything spawns from outside a runtime.
pub fn install(handle: Handle) -> Result<(), AlreadyInstalled> {
    HOST_RUNTIME.install(handle)
}

/// The runtime [`spawn`] would use from this thread right now.
pub fn handle() -> Handle {
    if let Ok(current) = Handle::try_current() {
        return current;
    }
    if let Some(installed) = HOST_RUNTIME.try_get() {
        return installed.clone();
    }
    FALLBACK
        .get_or_init(|| {
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .thread_name("cognia-rt")
                .build()
                .expect("cognia_core::rt could not build its fallback runtime")
        })
        .handle()
        .clone()
}

/// Spawn `future` on the app's runtime. See the module docs for which one.
pub fn spawn<F>(future: F) -> JoinHandle<F::Output>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    handle().spawn(future)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn spawns_on_the_runtime_the_caller_is_inside() {
        let current = Handle::current().id();
        assert_eq!(handle().id(), current);
        let ran_on = spawn(async { Handle::current().id() }).await.unwrap();
        assert_eq!(ran_on, current);
    }

    /// A thread outside any runtime (the desktop's main thread during
    /// `setup()`) gets the installed host runtime, and a second install is
    /// reported. One test, because the slot is process-global: the runtime
    /// is leaked so it outlives every test that might spawn onto it.
    #[test]
    fn a_thread_outside_any_runtime_uses_the_installed_one() {
        let host: &'static Runtime = Box::leak(Box::new(
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(1)
                .enable_all()
                .build()
                .unwrap(),
        ));
        install(host.handle().clone()).expect("first install");
        assert!(install(host.handle().clone()).is_err());
        let expected = host.handle().id();

        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let joined = spawn(async { Handle::current().id() });
            tx.send((handle().id(), joined)).unwrap();
        })
        .join()
        .unwrap();
        let (seen, joined) = rx.recv().unwrap();
        assert_eq!(seen, expected);
        assert_eq!(host.block_on(joined).unwrap(), expected);
    }
}
