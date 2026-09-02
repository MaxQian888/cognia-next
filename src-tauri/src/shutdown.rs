//! Graceful shutdown on process termination signals.
//!
//! Tauri's teardown — stop the loopback CLI-bridge socket, shut down cua
//! sandbox containers, kill auto-spawned external-agent / ACP child processes,
//! and clear the crash sentinel — only runs when the app is asked to exit
//! *through the event loop*: a normal quit, Cmd+Q, or [`AppHandle::exit`]. Its
//! wiring lives in the `RunEvent::ExitRequested | RunEvent::Exit` arm of
//! `run()`'s callback.
//!
//! A raw `SIGINT` (the terminal Ctrl+C under `pnpm tauri dev`) or `SIGTERM`
//! never reaches that arm: with no handler installed the kernel applies the
//! default "terminate" disposition and hard-kills the process first. The
//! crash-monitor child and sidecars are orphaned, the CLI-bridge socket is
//! leaked, and — because [`crash::sentinel::mark_clean_exit`] never fires — the
//! *next* launch mistakes the abrupt kill for a crash and raises the recovery
//! dialog.
//!
//! [`install`] hooks those signals and routes the first one through
//! [`AppHandle::exit`], so Ctrl+C replays the exact graceful teardown of a
//! normal quit. A second signal force-exits, so a wedged teardown can never
//! trap the user on the terminal.
//!
//! [`AppHandle::exit`]: tauri::AppHandle::exit
//! [`crash::sentinel::mark_clean_exit`]: crate::crash::sentinel::mark_clean_exit

/// Exit code for a signal-driven shutdown: 128 + SIGINT(2), the shell
/// convention for "terminated by Ctrl+C".
const SIGINT_EXIT_CODE: i32 = 130;

/// The exit code a forced (second-signal) shutdown reports. Public so the
/// headless binary's escape hatch exits with the same convention as the
/// desktop's.
pub const SIGNAL_EXIT_CODE: i32 = SIGINT_EXIT_CODE;

/// Spawn the shutdown-signal listener. Best-effort — a failure to hook the
/// signals is logged and leaves the kernel default in place (Ctrl+C still
/// kills the process, just without graceful teardown), so the app keeps
/// booting either way.
#[cfg(desktop)]
pub fn install(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        // First signal: ask Tauri to exit so the `RunEvent` teardown runs.
        wait_for_signal().await;
        log::info!("shutdown signal received — requesting graceful exit");
        app.exit(0);

        // Escape hatch: if teardown wedges (a child process that refuses to
        // die, a stuck async shutdown), a second signal hard-exits instead of
        // trapping the user — the kernel default is already suppressed, so
        // without this a repeated Ctrl+C would do nothing.
        wait_for_signal().await;
        log::warn!("second shutdown signal — forcing exit");
        std::process::exit(SIGINT_EXIT_CODE);
    });
}

/// Resolve once the process receives a termination signal: `SIGINT` or
/// `SIGTERM` on Unix, Ctrl+C on Windows.
///
/// Constructing the signal streams installs the OS handlers, which replaces
/// the default "terminate" disposition — so the signal is delivered here
/// rather than killing the process. On a hook failure the future parks
/// forever (the caller degrades to the kernel default on the *next* signal).
///
/// Shared with the headless `cognia-server` binary, which has no Tauri event
/// loop to route through but the same obligation: a `SIGTERM` from systemd,
/// Docker or `kill <pid>` must drain the companion listeners and reap the
/// brain / sidecar children exactly like Ctrl-C does.
#[cfg(unix)]
pub async fn wait_for_signal() {
    use tokio::signal::unix::{signal, SignalKind};

    let mut interrupt = match signal(SignalKind::interrupt()) {
        Ok(stream) => stream,
        Err(error) => {
            log::warn!("failed to hook SIGINT: {error}");
            return std::future::pending().await;
        }
    };
    let mut terminate = match signal(SignalKind::terminate()) {
        Ok(stream) => stream,
        Err(error) => {
            log::warn!("failed to hook SIGTERM: {error}");
            return std::future::pending().await;
        }
    };

    tokio::select! {
        _ = interrupt.recv() => {}
        _ = terminate.recv() => {}
    }
}

#[cfg(not(unix))]
pub async fn wait_for_signal() {
    if let Err(error) = tokio::signal::ctrl_c().await {
        log::warn!("failed to hook Ctrl+C: {error}");
        std::future::pending().await
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::time::Duration;

    /// `wait_for_signal` must resolve when the process is interrupted. The
    /// stream is built (installing the tokio handler) before the delayed
    /// self-`SIGINT` fires, so the signal is intercepted here instead of
    /// terminating the test binary.
    #[tokio::test]
    async fn wait_for_signal_resolves_on_sigint() {
        let raiser = tokio::spawn(async {
            tokio::time::sleep(Duration::from_millis(100)).await;
            // SAFETY: raising a signal at our own process is always sound.
            #[allow(unsafe_code)]
            unsafe {
                libc::raise(libc::SIGINT);
            }
        });

        tokio::time::timeout(Duration::from_secs(5), wait_for_signal())
            .await
            .expect("wait_for_signal must resolve after SIGINT");

        raiser.await.expect("raiser task panicked");
    }

    /// A second interrupt is caught too — the force-exit escape hatch reuses
    /// the same helper, so it must not swallow only the first signal.
    #[tokio::test]
    async fn wait_for_signal_resolves_on_repeated_sigint() {
        for _ in 0..2 {
            let raiser = tokio::spawn(async {
                tokio::time::sleep(Duration::from_millis(50)).await;
                // SAFETY: raising a signal at our own process is always sound.
                #[allow(unsafe_code)]
                unsafe {
                    libc::raise(libc::SIGINT);
                }
            });
            tokio::time::timeout(Duration::from_secs(5), wait_for_signal())
                .await
                .expect("wait_for_signal must resolve on each SIGINT");
            raiser.await.expect("raiser task panicked");
        }
    }

    /// `SIGTERM` — what systemd, Docker and `kill <pid>` send — must resolve
    /// the same helper. The headless server relies on this: without the hook
    /// the kernel default hard-kills it mid-drain.
    #[tokio::test]
    async fn wait_for_signal_resolves_on_sigterm() {
        let raiser = tokio::spawn(async {
            tokio::time::sleep(Duration::from_millis(100)).await;
            // SAFETY: raising a signal at our own process is always sound.
            #[allow(unsafe_code)]
            unsafe {
                libc::raise(libc::SIGTERM);
            }
        });

        tokio::time::timeout(Duration::from_secs(5), wait_for_signal())
            .await
            .expect("wait_for_signal must resolve after SIGTERM");

        raiser.await.expect("raiser task panicked");
    }

    #[test]
    fn sigint_exit_code_follows_shell_convention() {
        // 128 + SIGINT(2) — what a Ctrl+C-terminated process reports.
        assert_eq!(SIGINT_EXIT_CODE, 128 + libc::SIGINT);
    }
}
