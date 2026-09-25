//! Host services the desktop boot installs before any subsystem step runs.
//!
//! These installs used to live in a first `.setup(..)` closure in `lib.rs`.
//! Tauri keeps only the last closure handed to `Builder::setup`
//! (`self.setup = Box::new(setup)`), and `lib.rs` registered a second one, so
//! none of them ever ran on desktop. They now run inside the one setup hook the
//! builder keeps, right after the logger is installed (so their failures are
//! recorded) and before the gateway auto-start step (which needs the bridge).
//!
//! Every step logs and continues on failure: a boot that cannot, say, widen
//! the backups fs scope must still open its window.

use std::path::{Path, PathBuf};

use tauri::Manager as _;
use tauri_plugin_fs::FsExt as _;

/// The installs [`install`] runs, in order. Pinned by a test so a step cannot
/// be dropped from the boot silently again.
pub(crate) const STEP_NAMES: [&str; 6] = [
    "push_credentials",
    "default_allowed_roots",
    "backup_fs_scope",
    "task_workspace_maintenance",
    "gateway_brain_bridge",
    "wasm_host_services",
];

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
    crate::files::seed_default_allowed_roots(&[
        crate::agents::paths::vendor_roots().pi_agent_dir,
    ]);

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

    log::info!("host services installed: {}", STEP_NAMES.join(", "));
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Tauri keeps only the last `Builder::setup` closure, so a second
    /// `.setup(` in `lib.rs` silently discards the first one's work.
    #[test]
    fn lib_rs_registers_exactly_one_setup_hook() {
        let lib_rs = include_str!("../lib.rs");
        let setup_calls = lib_rs
            .lines()
            .map(str::trim_start)
            .filter(|line| !line.starts_with("//"))
            .filter(|line| line.starts_with(".setup("))
            .count();
        assert_eq!(
            setup_calls, 1,
            "lib.rs must register exactly one setup hook"
        );
    }

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
            ]
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

    /// The setup hook installs host services after the logger exists (a record
    /// written before `logging::bootstrap` is dropped) and before the gateway
    /// auto-start step spawns, which needs the brain bridge in place.
    #[test]
    fn the_setup_hook_installs_host_services_between_logging_and_gateway() {
        let lib_rs = include_str!("../lib.rs");
        let position = |needle: &str| {
            lib_rs
                .find(needle)
                .unwrap_or_else(|| panic!("lib.rs no longer contains `{needle}`"))
        };
        let setup_at = position("\n        .setup(|app| {");
        let logging_at = position("logging::bootstrap(app)");
        let install_at = position("startup::host_services::install(app);");
        let gateway_at = position("Inbound LLM gateway auto-start");
        assert!(setup_at < logging_at);
        assert!(logging_at < install_at);
        assert!(install_at < gateway_at);
    }
}
