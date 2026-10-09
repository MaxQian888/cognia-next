//! Boot steps for the desktop shell itself: global shortcuts, deep links, CLI
//! matches, the menu and tray, the main window's recovery and close behavior,
//! and graceful shutdown. Desktop-only; each step carries the `cfg` its
//! inline block had.

#[cfg(desktop)]
use tauri::{App, Emitter, Manager};

/// Seed the unified shortcut registry with the three built-in bindings. The
/// registry owns OS-level register/unregister so the renderer can rebind any
/// of these at runtime without our help. Routing logic lives in the plugin
/// builder's handler in `lib.rs` (delegates to `ShortcutRegistry::dispatch`).
#[cfg(all(desktop, not(any(target_os = "android", target_os = "ios"))))]
pub(crate) fn shortcuts(app: &App) {
    let registry = app
        .state::<std::sync::Arc<crate::shortcuts::ShortcutRegistry>>()
        .inner()
        .clone();
    crate::shortcuts::registry::seed_builtins(app.handle(), &registry);
}

/// Deep-link runtime registration & event listener. On Linux/dev-Windows the
/// OS doesn't auto-register schemes from the bundle config — `register_all`
/// does it at runtime. Idempotent on macOS and release Windows, where the
/// bundle already registered the scheme.
#[cfg(desktop)]
pub(crate) fn deep_links(app: &App) {
    use tauri_plugin_deep_link::DeepLinkExt;

    #[cfg(any(target_os = "linux", all(debug_assertions, target_os = "windows")))]
    {
        if let Err(e) = app.deep_link().register_all() {
            log::warn!("failed to register deep-link schemes: {e}");
        }
    }
    let app_handle = app.handle().clone();
    app.deep_link().on_open_url(move |event| {
        let urls: Vec<String> = event.urls().iter().map(|u| u.to_string()).collect();
        log::info!("deep-link received: {urls:?}");
        let _ = app_handle.emit("deep-link://received", urls);
    });
}

/// Forward initial CLI matches to the frontend on first launch. The
/// `cli://second-instance` event covers re-launches.
#[cfg(all(desktop, not(any(target_os = "android", target_os = "ios"))))]
pub(crate) fn cli_matches(app: &App) {
    use tauri_plugin_cli::CliExt;
    match app.cli().matches() {
        Ok(matches) => {
            if let Ok(payload) = serde_json::to_value(&matches) {
                let _ = app.emit("cli://matches", payload);
            }
        }
        Err(e) => log::warn!("failed to read CLI matches: {e}"),
    }
}

/// Build the application menu and the system tray. Both route their events
/// through `app.on_menu_event` and `tray://*` events that the frontend
/// subscribes to.
#[cfg(desktop)]
pub(crate) fn menu_and_tray(app: &App) {
    if let Err(e) = crate::menu::install(app) {
        log::warn!("failed to install application menu: {e}");
    }
    if let Err(e) = crate::tray::install(app) {
        log::warn!("failed to install tray icon: {e}");
    }
}

/// Honor the user's window close-button preference. `Quit` exits the app
/// (every window, overlays included); `Tray` hides the window so the app
/// keeps living in the system tray; `Ask` intercepts the close and asks the
/// frontend to show the exit-confirmation dialog. The tray menu's "Quit"
/// always exits cleanly regardless, since it routes through
/// PredefinedMenuItem.
#[cfg(desktop)]
pub(crate) fn main_window(app: &App) {
    use crate::webview_watchdog;
    use crate::window_behavior::{CloseBehavior, WindowBehavior};
    use tauri::WindowEvent;

    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    // Recover a window the window-state plugin restored off-screen (a monitor
    // was disconnected/rearranged since last exit). Runs while the window is
    // still hidden, so the user only ever sees it centered on a live display.
    // FULLSCREEN restore is already disabled at the plugin level in `lib.rs`.
    crate::window_recovery::recenter_if_offscreen(&window);

    // Paint the still-hidden window in the theme it will open in. The boot
    // reveal safety net can show it before the renderer's first frame, and the
    // static `backgroundColor` in `tauri.conf.json` is dark, which flashed dark
    // ahead of every light-themed launch.
    let os_dark = matches!(window.theme(), Ok(tauri::Theme::Dark));
    let saved = crate::commands::read_shell_background(app.handle());
    let color = crate::commands::boot_shell_background(saved.as_ref(), os_dark);
    if let Err(error) = window.set_background_color(Some(color)) {
        log::warn!("main window: failed to apply boot background: {error}");
    }

    // Runtime white-screen watchdog. The renderer beats a realm-lifetime
    // heartbeat; if it goes silent while the window is visible (renderer
    // process crash, hung main thread, a page navigated to a blank/broken
    // document) the React error boundaries can't fire — the JS realm is dead —
    // so this loop reloads the page back to its last-known-good route. This is
    // the runtime counterpart to the boot-time force-show and
    // window_recovery's off-screen recenter. Off in debug builds, where a
    // dev-server compile trips it (see
    // `webview_watchdog::heartbeat_recovery_enabled_for`).
    if webview_watchdog::heartbeat_recovery_enabled() {
        let handle = app.handle().clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(webview_watchdog::POLL_INTERVAL).await;
                let Some(window) = handle.get_webview_window("main") else {
                    continue;
                };
                let watchdog = handle.state::<webview_watchdog::WebviewWatchdog>();
                let visible = window.is_visible().unwrap_or(false);
                match watchdog.poll(std::time::Instant::now(), visible) {
                    webview_watchdog::WatchdogAction::Recover => {
                        // The watchdog owns *detection*; the recovery
                        // controller owns *policy* (ADR-0102 §4: one reload
                        // per five minutes, the second failure opening the
                        // one-shot safe shell, no automatic reloads after that
                        // until health recovers).
                        let controller = crate::recovery::controller();
                        if automatic_reloads_suspended(controller.map(|c| &**c)) {
                            // The shell is already open. Reloading again would
                            // flash away the very diagnostics screen the user
                            // is trying to read.
                            if watchdog.mark_gave_up_logged() {
                                log::error!(
                                    "recovery: automatic reloads are disabled \
                                     until health recovers"
                                );
                            }
                            continue;
                        }
                        if matches!(
                            controller.map(|controller| controller.record_renderer_failure()),
                            Some(cognia_observability::recovery::RendererAction::OpenSafeShell)
                        ) {
                            log::error!(
                                "recovery: renderer reload budget exhausted; \
                                 reloading into the diagnostics shell"
                            );
                        }
                        let url = watchdog.last_url();
                        webview_watchdog::recover(&window, url.as_deref());
                        watchdog.note_recovery(std::time::Instant::now());
                    }
                    webview_watchdog::WatchdogAction::GaveUp => {
                        if watchdog.mark_gave_up_logged() {
                            log::error!(
                                "webview-watchdog: page still blank after {} reloads; giving up auto-recovery",
                                webview_watchdog::MAX_RECOVERIES
                            );
                        }
                    }
                    webview_watchdog::WatchdogAction::Idle => {}
                }
            }
        });
    } else {
        log::info!(
            "webview-watchdog: heartbeat recovery is off in this debug build; set {}=1 to enable it",
            webview_watchdog::HEARTBEAT_RECOVERY_ENV
        );
    }

    let handle = app.handle().clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            let behavior = handle.state::<WindowBehavior>();
            match behavior.close_behavior() {
                // "Quit" means the app, not this one window. Tauri only exits
                // when the LAST window closes, and the desktop pet, its popup,
                // the fleet island and the other overlays are windows too, so
                // letting the close through left the process alive behind a
                // frozen pet with no controller and no main window to reach.
                // Exiting runs the `RunEvent::ExitRequested` teardown, which
                // takes every window down with the app.
                CloseBehavior::Quit => {
                    api.prevent_close();
                    handle.exit(0);
                }
                CloseBehavior::Tray => {
                    api.prevent_close();
                    if let Some(w) = handle.get_webview_window("main") {
                        let _ = w.hide();
                    }
                }
                CloseBehavior::Ask => {
                    api.prevent_close();
                    let _ = handle.emit("app://close-requested", ());
                }
            }
        }
    });
}

/// Whether recovery has suspended automatic reloads (ADR-0102 §4): once the
/// renderer's reload budget opens the safe shell, nothing reloads again until
/// health recovers. Before recovery publishes its controller, nothing is
/// suspended.
#[cfg(desktop)]
fn automatic_reloads_suspended(controller: Option<&crate::recovery::RecoveryController>) -> bool {
    controller.is_some_and(|controller| {
        controller
            .snapshot()
            .renderer_reload
            .automatic_reloads_disabled
    })
}

/// Graceful shutdown on Ctrl+C / SIGTERM. Without this a terminal interrupt
/// under `pnpm tauri dev` hard-kills the process before the
/// `RunEvent::ExitRequested` teardown in `lib.rs` runs, orphaning the
/// crash-monitor child + sidecars and leaving the crash sentinel dirty (so the
/// next launch falsely reports a crash). Desktop-only.
#[cfg(desktop)]
pub(crate) fn shutdown_signal(app: &App) {
    crate::shutdown::install(app.handle().clone());
}

#[cfg(test)]
#[cfg(desktop)]
mod tests {
    use super::*;
    use crate::recovery::RecoveryController;
    use cognia_observability::recovery::RendererAction;

    #[test]
    fn the_watchdog_stops_reloading_once_recovery_opens_the_safe_shell() {
        assert!(!automatic_reloads_suspended(None));

        // Detached: no store, no audit writer, so this touches no disk.
        let controller = RecoveryController::detached("startup-shell-test");
        assert!(!automatic_reloads_suspended(Some(&controller)));

        let mut failures = 0;
        while !matches!(
            controller.record_renderer_failure(),
            RendererAction::OpenSafeShell
        ) {
            failures += 1;
            assert!(
                failures < 10,
                "the reload budget never opened the safe shell"
            );
            assert!(!automatic_reloads_suspended(Some(&controller)));
        }
        assert!(automatic_reloads_suspended(Some(&controller)));
    }
}
