//! Tauri commands for the inbound gateway. Each mirrors a function in
//! `lib/tauri/gateway.ts` 1:1.

use tauri::{AppHandle, State};

use super::keyring as gw_keyring;
use super::snapshot::RoutingSnapshot;
use super::types::{GatewayConfig, GatewayStatus};
use super::GatewayState;

#[tauri::command]
pub async fn gateway_get_status(state: State<'_, GatewayState>) -> Result<GatewayStatus, String> {
    Ok(state.status())
}

#[tauri::command]
pub async fn gateway_update_config(
    state: State<'_, GatewayState>,
    config: GatewayConfig,
) -> Result<(), String> {
    state.update_config(config);
    Ok(())
}

#[tauri::command]
pub async fn gateway_start(state: State<'_, GatewayState>, app: AppHandle) -> Result<(), String> {
    state.start(app).await.map_err(Into::into)
}

#[tauri::command]
pub async fn gateway_stop(state: State<'_, GatewayState>) -> Result<(), String> {
    state.stop().map_err(Into::into)
}

#[tauri::command]
pub async fn gateway_get_token(state: State<'_, GatewayState>) -> Result<Option<String>, String> {
    let token = gw_keyring::read_token()?;
    state.record_token_presence(token.is_some());
    Ok(token)
}

#[tauri::command]
pub async fn gateway_rotate_token(state: State<'_, GatewayState>) -> Result<String, String> {
    let token = gw_keyring::generate_token();
    gw_keyring::write_token(&token)?;
    state.record_token_presence(true);
    Ok(token)
}

/// Push the renderer's latest routing+credential snapshot into the live
/// server. The snapshot carries API keys — they stay in Rust memory only.
#[tauri::command]
pub async fn gateway_push_snapshot(
    state: State<'_, GatewayState>,
    snapshot: RoutingSnapshot,
) -> Result<(), String> {
    state.set_snapshot(snapshot);
    Ok(())
}

/// Answer a live routing decision the server requested via `gateway://decide`.
/// `entries` is the renderer's full-engine pre-ordered candidate chain; an
/// empty list (or never answering) leaves the server to fall back to the
/// snapshot. Unknown / timed-out request ids are a silent no-op.
#[tauri::command]
pub async fn gateway_decision_response(
    state: State<'_, GatewayState>,
    request_id: String,
    entries: Vec<super::snapshot::SnapshotEntry>,
) -> Result<(), String> {
    state.resolve_decision(&request_id, entries);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_config_round_trips() {
        let state = GatewayState::new();
        let mut cfg = GatewayConfig::default();
        cfg.rate_limit_per_min = 120;
        state.update_config(cfg);
        assert_eq!(state.config().rate_limit_per_min, 120);
    }
}
