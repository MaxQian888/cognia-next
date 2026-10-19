//! Waiting for a process termination signal, for every long-running binary.
//!
//! The desktop routes the first signal through Tauri's graceful exit
//! (`src-tauri/src/shutdown.rs`); the headless `cognia-server` drains its
//! listeners and reaps its brain and sidecar children. Both need the same
//! two things: a future that resolves on `SIGINT` *or* `SIGTERM`, and one
//! exit code for the forced, second-signal path.

/// Exit code for a signal-driven shutdown: 128 + SIGINT(2), the shell
/// convention for "terminated by Ctrl+C".
const SIGINT_EXIT_CODE: i32 = 130;

/// The exit code a forced (second-signal) shutdown reports. Shared so the
/// headless binary's escape hatch exits with the same convention as the
/// desktop's.
pub const SIGNAL_EXIT_CODE: i32 = SIGINT_EXIT_CODE;

/// Resolve once the process receives a termination signal: `SIGINT` or
/// `SIGTERM` on Unix, Ctrl+C on Windows.
///
/// Constructing the signal streams installs the OS handlers, which replaces
/// the default "terminate" disposition — so the signal is delivered here
/// rather than killing the process. On a hook failure the future parks
/// forever (the caller degrades to the kernel default on the *next* signal).
///
/// The headless `cognia-server` has no Tauri event loop to route through but
/// the desktop's obligation: a `SIGTERM` from systemd, Docker or `kill <pid>`
/// must drain the companion listeners and reap the brain / sidecar children
/// exactly like Ctrl-C does.
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
