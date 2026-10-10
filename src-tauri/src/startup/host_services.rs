//! Host services the desktop boot installs before any subsystem step runs.
//!
//! These installs used to live in a first `.setup(..)` closure in `lib.rs`.
//! Tauri keeps only the last closure handed to `Builder::setup`
//! (`self.setup = Box::new(setup)`), and `lib.rs` registered a second one, so
//! none of them ever ran on desktop. They now run as the `host_services` boot
//! step (see `startup::STEPS`), right after the logger is installed (so their
//! failures are recorded) and before the gateway auto-start step (which needs
//! the bridge).
//!
//! Every step logs and continues on failure: a boot that cannot, say, widen
//! the backups fs scope must still open its window.

use std::path::{Path, PathBuf};

use tauri::Manager as _;
use tauri_plugin_fs::FsExt as _;

/// The installs [`install`] runs, in order. Pinned by a test so a step cannot
/// be dropped from the boot silently again.
pub(crate) const STEP_NAMES: [&str; 8] = [
    "push_credentials",
    "default_allowed_roots",
    "backup_fs_scope",
    "task_workspace_maintenance",
    "gateway_brain_bridge",
    "wasm_host_services",
    "crash_screenshot_capture",
    "file_share",
];

/// The task worktrees conversations run in, under the data dir `lib.rs` hands
/// the task-workspace service. A live file share may serve them (ADR-0222).
pub(crate) fn managed_execution_dir(task_workspace_data_dir: &Path) -> PathBuf {
    task_workspace_data_dir.join("task-workspaces").join("executions")
}

/// The directory the atomic backup stream writes into, mirrored into the
/// dynamic fs scope so the stream helper may write there.
pub(crate) fn backup_scope_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("backups")
}

/// Run every host-service install. Never fails; each step logs its own error.
pub(crate) fn install(app: &tauri::App) {
    // Install the keyring-backed push credential store and reinstate any
    // FCM/APNs dispatchers the user uploaded in a prior session. Keyring
    // access is blocking OS-credential I/O that can take hundreds of ms on a
    // cold credential subsystem, and setup() runs before the window paints,
    // so it happens off the startup path. No push fires during boot (a
    // connector has to be running first) and the pre-install push path already
    // warns, so installing a moment later is safe.
    tauri::async_runtime::spawn_blocking(|| {
        crate::companion_api::push_creds::install(
            crate::companion_api::push_creds::KeyringPushCredStore::new(),
        );
        if let Err(err) = crate::companion_api::push_creds::reinstall_persisted_dispatchers() {
            log::warn!("push-creds reinstall failed: {err}");
        }
    });

    // Seed the fs allowed-roots registry: app data, the agent config trees and
    // Documents, plus Pi's config dir wherever `$PI_CODING_AGENT_DIR` puts it.
    // Pure in-memory inserts; the renderer adds the active workspace roots
    // once it loads.
    crate::files::seed_default_allowed_roots(&[crate::agents::paths::vendor_roots().pi_agent_dir]);

    // Mirror the narrow static backup scope in the dynamic scope used by the
    // atomic stream helper; existing deny patterns still win.
    match app.path().app_data_dir() {
        Ok(app_data_dir) => {
            if let Err(err) = app
                .fs_scope()
                .allow_directory(backup_scope_dir(&app_data_dir), true)
            {
                log::warn!("backup fs scope could not be widened: {err}");
            }
        }
        Err(err) => log::warn!("backup fs scope skipped, no app data dir: {err}"),
    }

    // Maintenance spawns onto the current Tokio runtime. setup() runs on the
    // main thread, which `main.rs` never enters (it only registers the handle
    // with `tauri::async_runtime::set`), so enter it for the call.
    {
        let runtime = tauri::async_runtime::handle();
        let _entered = runtime.inner().enter();
        crate::task_workspace::start_workspace_maintenance();
    }

    // Give the gateway its link to the brain (ADR-0188 D9). Installing it does
    // not switch anything on: `/v1/runs` stays refused until the renderer
    // pushes a snapshot saying the `gatewayRuns` surface is on.
    app.state::<crate::gateway::GatewayState>()
        .runs
        .install_bridge(crate::gateway_brain_bridge::DesktopBrainBridge::new(
            app.handle().clone(),
        ));

    // Hand the WASM plugin host its Tauri-backed surfaces (ADR-0013,
    // api-version 0.2). Clipboard and notifications are served in-process; AI
    // and workflow go through the renderer bridge this also creates. Headless
    // hosts (`cognia-server`) never run this, so their
    // `WasmPluginState::services` stays `None` and every capability needing a
    // backend answers HOST_UNAVAILABLE while logger / secrets / process keep
    // working.
    let wasm_state = app.state::<crate::plugin_api::wasm::WasmPluginState>();
    crate::plugin_api::wasm::WasmPluginHost::install_host_services(
        &wasm_state,
        std::sync::Arc::new(
            crate::plugin_api::wasm::services::tauri::TauriWasmHostServices::new(
                app.handle().clone(),
            ),
        ),
    );

    // Give the crash reporter its screen capture. `cognia-observability`
    // declares the slot so it does not link the UI-automation stack for this
    // one call (ADR-0196); unset, reports go out without a screenshot.
    if let Err(err) = crate::crash::submit::SCREENSHOT_CAPTURE.install(capture_primary_screen_png) {
        log::warn!("{err}");
    }

    install_file_share(app);

    log::info!("host services installed: {}", STEP_NAMES.join(", "));
}

/// Install the live file-share service (ADR-0222). Nothing is served yet: the
/// renderer activates the unlocked account and pushes the policy and mount
/// tables, and the listener starts only if its saved settings enable it.
/// Dexie-backed mounts (`/uploads`, `/artifacts`) and mount tables are read
/// from the WebView over the companion bridge.
fn install_file_share(app: &tauri::App) {
    let Ok(app_data_dir) = app.path().app_data_dir() else {
        log::warn!("file share: no app data dir; live file sharing is off");
        return;
    };
    let managed = dirs::data_dir().map(|dir| managed_execution_dir(&dir.join("cognia")));
    let validator = cognia_file_share::mounts::registered_root_validator(move |path| {
        cognia_files::files::is_shareable_workspace_path(path, managed.as_deref())
    });
    let service = cognia_file_share::service::install(app_data_dir, validator);
    let companion = app.state::<crate::companion_api::CompanionServerState>();
    let bridge = std::sync::Arc::new(cognia_companion::filespace_bridge::BridgeFileSpaceSource::webview(
        std::sync::Arc::clone(&companion.desktop_messages_bridge),
        std::sync::Arc::new(cognia_companion_bus::bridge_transport::WebViewBridgeTransport(
            app.handle().clone(),
        )),
    ));
    service.set_asset_reader(bridge.clone());
    service.set_mount_source(bridge);
    // The account session, not the renderer, says which account is unlocked.
    app.state::<crate::account_auth::AccountSecuritySession>()
        .attach_file_share(service);
}

/// The primary screen as PNG bytes, for the crash reporter's attachment.
fn capture_primary_screen_png() -> Option<Vec<u8>> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let shot = crate::automation::platform::shared::screenshot::capture_primary(
        &crate::automation::types::ScreenshotOpts::default(),
    )
    .ok()?;
    STANDARD.decode(shot.bytes).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_formerly_dead_installs_are_all_listed() {
        assert_eq!(
            STEP_NAMES,
            [
                "push_credentials",
                "default_allowed_roots",
                "backup_fs_scope",
                "task_workspace_maintenance",
                "gateway_brain_bridge",
                "wasm_host_services",
                "crash_screenshot_capture",
                "file_share",
            ]
        );
    }

    #[test]
    fn shares_reach_the_task_worktrees_the_workspace_service_creates() {
        assert_eq!(
            managed_execution_dir(Path::new("/data/cognia")),
            PathBuf::from("/data/cognia/task-workspaces/executions")
        );
    }

    #[test]
    fn the_backup_scope_sits_under_app_data() {
        let app_data = Path::new("/data/com.cognia.app");
        assert_eq!(
            backup_scope_dir(app_data),
            PathBuf::from("/data/com.cognia.app/backups")
        );
    }
}
