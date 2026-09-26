//! Agent Fleet lives in `cognia-fleet` (ADR-0196 P6d); this module re-exports
//! it, so `generate_handler!`'s `fleet::…` paths and every `crate::fleet::…`
//! call resolve unchanged. What stays is desktop-bound: the island overlay
//! windows, the monitor commands that start the companion listener, the
//! snapshot sink that emits `fleet://update` to the island webview, and the
//! companion view a snapshot projects tenants through.

pub use cognia_fleet::commands::*;
pub use cognia_fleet::*;

pub mod island_space;
pub mod island_window;

use std::sync::Arc;

use cognia_fleet::companion::{FleetCompanion, COMPANION};
use cognia_fleet::registry::{FleetHost, FleetSnapshot};
use tauri::Emitter as _;

/// Emits every Fleet snapshot to the island webview.
struct IslandUpdateSink(tauri::AppHandle);

impl FleetUpdateSink for IslandUpdateSink {
    fn emit(&self, snapshot: &FleetSnapshot) {
        let _ = self.0.emit(UPDATE_EVENT, snapshot);
    }
}

/// The companion core's side of a Fleet snapshot: the connected brain and the
/// tenant's worker hosts.
struct CompanionFleetView;

impl FleetCompanion for CompanionFleetView {
    fn brain_account_id(&self) -> Option<String> {
        crate::companion_api::ws_bridge::current_brain_account_id()
    }

    fn hosts(&self, tenant_id: &str) -> Vec<FleetHost> {
        crate::companion_api::ws_worker::fleet_hosts(tenant_id)
    }
}

/// Give Fleet snapshots the companion view. Desktop boot and the headless
/// services install call this; a process that skips it projects no brain and
/// lists no worker hosts.
pub(crate) fn install_companion_view() {
    COMPANION.set(Arc::new(CompanionFleetView));
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Enable fleet monitoring: ensure the companion server is running (loopback,
/// default port), mint a fresh ingress token, publish
/// `~/.cognia/agent-monitor.json` for the hook scripts, and start the reaper.
#[tauri::command]
pub async fn fleet_monitor_start(
    app: tauri::AppHandle,
    companion: tauri::State<'_, crate::companion_api::CompanionServerState>,
) -> Result<FleetMonitorStatus, String> {
    runtime().set_update_sink(Arc::new(IslandUpdateSink(app.clone())));

    // Reuse the companion server as the ingress listener (user decision: no
    // second HTTP server). Already-running → keeps its current port/bind.
    let port = match companion.bound_port() {
        Some(p) => p,
        None => crate::companion_api::commands::companion_server_start(
            companion.clone(),
            app.clone(),
            crate::companion_api::server::DEFAULT_PORT,
            true,
        )
        .await
        .map_err(|e| e.to_string())?,
    };

    start_monitor(port)
}

/// Boot-time restore: if `agent-monitor.json` is present the user had
/// monitoring enabled before the last quit (stop deletes the file), so
/// re-arm it — a fresh token is minted and the file rewritten, replacing the
/// stale token the persisted hook scripts would otherwise present to a dead
/// ingress. No-op (and reports disabled) when the file is absent.
#[tauri::command]
pub async fn fleet_monitor_restore(
    app: tauri::AppHandle,
    companion: tauri::State<'_, crate::companion_api::CompanionServerState>,
) -> Result<FleetMonitorStatus, String> {
    let was_enabled = install::monitor_config_path().is_some_and(|p| p.exists());
    if was_enabled {
        fleet_monitor_start(app, companion).await
    } else {
        Ok(FleetMonitorStatus {
            enabled: false,
            port: None,
            config_path: None,
        })
    }
}

/// Current monitor status for the settings card.
#[tauri::command]
pub async fn fleet_monitor_status(
    companion: tauri::State<'_, crate::companion_api::CompanionServerState>,
) -> Result<FleetMonitorStatus, String> {
    Ok(monitor_status(companion.bound_port()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Both binaries give Fleet its companion view at boot; without it a
    /// snapshot silently drops the brain gate and every worker host.
    #[test]
    fn both_binaries_install_the_companion_view() {
        let desktop = include_str!("../startup/telemetry.rs");
        let headless = include_str!("../headless/mod.rs");
        assert!(desktop.contains("crate::fleet::install_companion_view()"));
        assert!(headless.contains("crate::fleet::install_companion_view()"));
    }

    #[test]
    fn the_companion_view_reads_the_companion_core() {
        let view = CompanionFleetView;
        assert_eq!(
            view.brain_account_id(),
            crate::companion_api::ws_bridge::current_brain_account_id()
        );
    }
}
