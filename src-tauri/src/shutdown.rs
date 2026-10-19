//! Graceful shutdown on process termination signals.
//!
//! Tauri's teardown — stop the loopback CLI-bridge socket, shut down cua
//! sandbox containers, kill auto-spawned external-agent / ACP child processes,
//! and clear the crash sentinel — only runs when the app is asked to exit
//! *through the event loop*: a normal quit, Cmd+Q, or [`AppHandle::exit`]. Its
//! wiring lives in [`handle_run_event`], which defers ordinary quit until
//! async cleanup finishes without blocking the UI event loop.
//!
//! A raw `SIGINT` (the terminal Ctrl+C under `pnpm tauri dev`) or `SIGTERM`
//! never reaches that handler: with no handler installed the kernel applies the
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

pub use cognia_core::shutdown_signal::{wait_for_signal, SIGNAL_EXIT_CODE};
use std::sync::atomic::{AtomicU8, Ordering};
use tauri::Manager;

/// Ordinary quit is two-phase: keep the event loop alive until cleanup has
/// finished, then let the second exit request through. Repeated requests must
/// not run teardown twice against the same child-process registries.
#[derive(Default)]
pub(crate) struct ExitState(AtomicU8);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ExitAction {
    Start,
    Wait,
    Allow,
}

impl ExitState {
    fn request(&self) -> ExitAction {
        match self
            .0
            .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
        {
            Ok(_) => ExitAction::Start,
            Err(1) => ExitAction::Wait,
            Err(_) => ExitAction::Allow,
        }
    }

    fn complete(&self) {
        self.0.store(2, Ordering::Release);
    }
}

pub(crate) fn handle_run_event(app: &tauri::AppHandle, event: tauri::RunEvent) {
    let tauri::RunEvent::ExitRequested { api, code, .. } = event else {
        return;
    };
    let state = app.state::<ExitState>();
    // Tauri ignores prevent_exit for its reserved restart code. Preserve its
    // existing synchronous restart teardown; ordinary quit can be deferred.
    if code == Some(tauri::RESTART_EXIT_CODE) {
        if state.request() == ExitAction::Start {
            tauri::async_runtime::block_on(cleanup(app));
            state.complete();
        }
        return;
    }
    match state.request() {
        ExitAction::Allow => {}
        ExitAction::Wait => api.prevent_exit(),
        ExitAction::Start => {
            api.prevent_exit();
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                cleanup(&app).await;
                app.state::<ExitState>().complete();
                app.exit(code.unwrap_or(0));
            });
        }
    }
}

async fn cleanup(app_handle: &tauri::AppHandle) {
    log::info!("starting graceful app cleanup");
    let state = app_handle.state::<crate::cli_bridge::CliBridgeServerState>();
    crate::cli_bridge::shutdown(state.inner());
    // ADR-0201 — release the loopback file server's listeners. It
    // is an in-process axum server, not a child, so it is not in
    // `process_registry` (the local Chromium runtime is).
    if let Some(local_content) =
        app_handle.try_state::<crate::browser::local_content::LocalContentState>()
    {
        local_content.inner().shutdown().await;
    }
    // ADR-0020 remote-target. Drop the cached driver connections
    // and leave the containers running. A sandbox the user started
    // is a machine they expect to still be there next launch, and
    // `start` adopts it by its deterministic name rather than
    // creating a second one. Stopping here would silently discard
    // whatever the machine was in the middle of.
    let cua = app_handle
        .state::<crate::cua_sandbox::CuaSandboxRegistry>()
        .inner()
        .clone();
    cua.disconnect_all().await;
    // ADR-0106 — a quit mid-recording must leave a recoverable
    // bundle rather than a half-written one. `interrupt_blocking`
    // detaches the input hook and stamps the journal `Interrupted`
    // from this thread; it never deletes.
    app_handle
        .state::<crate::automation::commands::AutomationState>()
        .recorder
        .interrupt_blocking(crate::automation::record::journal::InterruptReason::AppShutdown);
    // Stop every cognia-spawned child process — external agents,
    // ACP terminals, chat sidecar, integrated terminal PTYs, the
    // MCP server, code-server instances, and the cloudflared
    // tunnel. `process_registry::teardown` is the single
    // exhaustive list; do NOT add subsystems here instead.
    crate::process_registry::teardown(app_handle).await;
    // Flush the recovery audit spool before the sentinel clears —
    // a shutdown that loses the audit trail loses the only record
    // of why this session entered recovery.
    if let Some(controller) =
        app_handle.try_state::<std::sync::Arc<crate::recovery::RecoveryController>>()
    {
        controller.close();
    }

    // Graceful shutdown — clear the crash sentinel so the next
    // launch doesn't mistake this clean exit for a crash.
    crate::crash::sentinel::mark_clean_exit();
    log::info!("graceful app cleanup complete");
}

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
        std::process::exit(SIGNAL_EXIT_CODE);
    });
}

#[cfg(test)]
mod exit_tests {
    use super::*;

    #[test]
    fn repeated_exit_waits_for_the_original_cleanup() {
        let state = ExitState::default();
        assert_eq!(state.request(), ExitAction::Start);
        assert_eq!(state.request(), ExitAction::Wait);
        state.complete();
        assert_eq!(state.request(), ExitAction::Allow);
        assert_eq!(state.request(), ExitAction::Allow);
    }

    #[test]
    fn concurrent_exit_requests_start_cleanup_once() {
        let state = std::sync::Arc::new(ExitState::default());
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let state = state.clone();
                std::thread::spawn(move || state.request())
            })
            .collect();
        let actions: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
        assert_eq!(
            actions.iter().filter(|&&a| a == ExitAction::Start).count(),
            1
        );
        assert_eq!(
            actions.iter().filter(|&&a| a == ExitAction::Wait).count(),
            7
        );
    }
}
