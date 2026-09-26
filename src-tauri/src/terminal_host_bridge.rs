//! Tauri facade for the durable terminal host.
//!
//! The bridge commands, their managed state and the one-shot host client live
//! in `cognia_terminal::host_bridge` / `cognia_terminal::host_client` and are
//! glob-re-exported here, so `generate_handler!` (which needs the commands'
//! `__cmd__*` macros, carried only by a module or glob re-export) and
//! `crate::terminal_host_bridge::…` paths resolve unchanged (ADR-0196).
//!
//! `terminal_host_service` stays here as a thin shell: a provisioned
//! descriptor falls back to the companion server's LAN URL, and
//! `CompanionServerState` belongs to the app.

use tauri::{AppHandle, Runtime, State};

pub use cognia_terminal::host_bridge::*;
pub use cognia_terminal::host_client::*;

#[tauri::command]
pub async fn terminal_host_service<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, TerminalHostBridgeState>,
    companion: State<'_, crate::companion_api::CompanionServerState>,
    action: TerminalHostServiceAction,
) -> Result<TerminalHostStatus, String> {
    run_terminal_host_service(&app, &state, action, || terminal_lan_url(&companion)).await
}

fn terminal_lan_url(state: &crate::companion_api::CompanionServerState) -> Option<String> {
    if state.bind_mode() != Some(crate::companion_api::BindMode::Lan) {
        return None;
    }
    let port = state.bound_port()?;
    let host = crate::companion_api::commands::detect_lan_ip()?;
    let host = if host.contains(':') {
        format!("[{host}]")
    } else {
        host
    };
    Some(format!("wss://{host}:{port}/ws/terminal"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_lan_url_is_absent_while_companion_is_stopped() {
        let state = crate::companion_api::CompanionServerState::new();
        assert_eq!(terminal_lan_url(&state), None);
    }
}
