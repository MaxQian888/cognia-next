//! Boot steps for logging, crash capture and recovery (ADR-0102), and the
//! retention sweep over what they write.

use tauri::{App, Manager};

/// Bootstrap native logging in *all* builds. Installs tauri-plugin-log with
/// stdout / file / webview targets and mirrors records into the OS-native
/// platform logger (EventLog / OSLog / journald). The frontend's unified
/// logger consumes the webview target via `log://log` events.
pub(crate) fn native_logging(app: &App) {
    if let Err(error) = crate::logging::bootstrap(app) {
        log::warn!("native_logging bootstrap failed: {error}");
    }
}

/// Crash subsystem. Register the app handle so capture paths can emit
/// `crash://captured` to the webview (and give the hooks runtime its desktop
/// host, and Fleet its companion view); detect an abnormal previous exit
/// (BEFORE writing this session's sentinel) and stash it for the next-launch
/// dialog; then mark this session running. Finally push an initial meta
/// snapshot to the out-of-process monitor so an immediate native crash still
/// carries app state.
pub(crate) fn crash_and_recovery(app: &App) {
    crate::crash::install_app_handle(app.handle().clone());
    crate::hooks::install_desktop_host(app.handle().clone());
    crate::fleet::install_companion_view();
    let pending = crate::crash::sentinel::take_pending();
    crate::crash::sentinel::mark_start();

    // ADR-0102 §4 — recovery must see the sentinel verdict BEFORE any
    // subsystem initializer runs, because its job is to decide whether they
    // run at all. The sentinel is the sole owner of "did the previous run
    // crash?"; recovery consumes that answer rather than forming a second
    // opinion.
    let controller = match crate::recovery::diagnostics_dir() {
        Some(dir) => crate::recovery::RecoveryController::open(
            &dir,
            crate::recovery::build_id(),
            env!("CARGO_PKG_VERSION"),
        ),
        None => {
            log::warn!("recovery: no diagnostics dir; safe mode reports unsupported this run");
            crate::recovery::RecoveryController::detached(crate::recovery::build_id())
        }
    };
    let controller = std::sync::Arc::new(controller);
    let boot = controller.record_start(pending.is_some());
    if boot.requires_safe_shell {
        log::warn!(
            "recovery: entering the diagnostics shell for build {} (suspect: {:?})",
            boot.build_id,
            controller.snapshot().suspect_subsystem
        );
    }
    // Publish before managing: supervised children (the chat sidecar's
    // detached reader task, the headless services) have no `AppHandle` to
    // look state up with, and the sidecar can be spawned by a background job
    // before the webview ever loads.
    crate::recovery::publish_controller(std::sync::Arc::clone(&controller));
    app.manage(controller);
    app.manage(boot);

    app.manage(crate::crash::commands::PendingCrashState::new(pending));
    crate::crash::context::publish_to_monitor();
}

/// Retention sweep — crash reports (30d / 50) + rotated logs (keep 5). Off the
/// hot path: spawn a thread so a slow disk never delays window paint.
/// Failures are best-effort; the outcome is recorded for the diagnostics
/// command.
pub(crate) fn retention_sweep(_app: &App) {
    std::thread::spawn(|| {
        if let Some(dir) = crate::crash::crash_reports_dir() {
            crate::crash::retention::prune_crash_reports(
                &dir,
                &crate::crash::retention::RetentionPolicy::default(),
                chrono::Utc::now(),
            );
        }
        if let Some(log_dir) = crate::logging::native_bootstrap::log_dir() {
            // The count was always returned and always discarded, so a sweep
            // that deleted twenty files looked like one that deleted none.
            // Record it — retention that cannot say what it removed is
            // indistinguishable from logs never written.
            let pruned = crate::crash::retention::prune_rotated_logs(
                &log_dir,
                crate::crash::retention::ROTATED_LOG_KEEP,
            );
            crate::crash::retention::record_rotated_prune(pruned);
        }
    });
}

#[cfg(test)]
mod tests {
    use crate::startup::step_position;

    /// Supervised children have no `AppHandle` to look the recovery controller
    /// up with, so [`super::crash_and_recovery`] publishes it globally — and a
    /// background job can spawn the chat sidecar before the webview loads.
    #[test]
    fn the_recovery_controller_is_published_before_jobs_can_spawn_the_sidecar() {
        assert!(step_position("crash_and_recovery") < step_position("jobs_supervisor"));
    }
}
