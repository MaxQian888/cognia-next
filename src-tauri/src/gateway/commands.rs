//! Tauri commands for the inbound gateway. Each mirrors a function in
//! `lib/tauri/gateway.ts` 1:1.

use tauri::{AppHandle, State};

use super::keyring as gw_keyring;
use super::snapshot::RoutingSnapshot;
use super::types::{GatewayConfig, GatewayError, GatewayStatus};
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
    state.update_config(config).map_err(Into::into)
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

#[tauri::command]
pub async fn gateway_clear_token(state: State<'_, GatewayState>) -> Result<(), String> {
    clear_token_inner(&state, gw_keyring::clear_token)
}

fn clear_token_inner(
    state: &GatewayState,
    clear_token: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    clear_token()?;
    if state.status().running {
        match state.stop() {
            Ok(()) => log::info!("gateway listener stopped because bearer token was cleared"),
            Err(GatewayError::NotRunning) => {}
            Err(error) => {
                log::warn!("gateway listener stop failed after token clear: {error}");
                return Err(error.into());
            }
        }
    }
    state.record_token_presence(false);
    Ok(())
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
        state.update_config(cfg).unwrap();
        assert_eq!(state.config().rate_limit_per_min, 120);
    }

    #[test]
    fn clear_token_inner_marks_gateway_as_tokenless_after_delete() {
        let state = GatewayState::new();
        state.record_token_presence(true);

        clear_token_inner(&state, || Ok(())).unwrap();

        assert!(!state.status().has_token);
    }

    #[test]
    fn clear_token_inner_preserves_presence_when_delete_fails() {
        let state = GatewayState::new();
        state.record_token_presence(true);

        let err = clear_token_inner(&state, || Err("keyring locked".to_string())).unwrap_err();

        assert_eq!(err, "keyring locked");
        assert!(state.status().has_token);
    }

    #[test]
    fn clear_token_inner_stops_running_gateway_before_forgetting_token() {
        let state = GatewayState::new();
        let (shutdown, _shutdown_rx) = tokio::sync::watch::channel(());
        {
            let mut inner = state.inner.lock();
            inner.config.enabled = true;
            inner.status.running = true;
            inner.status.bound_port = Some(47824);
            inner.status.has_token = true;
            inner.server = Some(crate::gateway::server::ServerHandle {
                bound_port: 47824,
                shutdown,
            });
        }

        clear_token_inner(&state, || Ok(())).unwrap();

        let status = state.status();
        assert!(!status.running);
        assert_eq!(status.bound_port, None);
        assert!(!status.has_token);
        assert!(!state.config().enabled);
        assert!(state.inner.lock().server.is_none());
    }
}
