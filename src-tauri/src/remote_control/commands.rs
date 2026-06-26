//! Tauri commands for the remote-control subsystem. Each one mirrors a
//! function in `lib/tauri/remote-control.ts` 1:1.

use tauri::{AppHandle, State};

use super::keyring as rc_keyring;
use super::types::{RemoteControlConfig, RemoteControlError, RemoteControlStatus};
use super::RemoteControlState;

#[tauri::command]
pub async fn remote_control_get_status(
    state: State<'_, RemoteControlState>,
) -> Result<RemoteControlStatus, RemoteControlError> {
    Ok(state.status())
}

#[tauri::command]
pub async fn remote_control_start(
    state: State<'_, RemoteControlState>,
    app: AppHandle,
) -> Result<(), RemoteControlError> {
    state.start(app).await
}

#[tauri::command]
pub async fn remote_control_stop(
    state: State<'_, RemoteControlState>,
) -> Result<(), RemoteControlError> {
    state.stop()
}

#[tauri::command]
pub async fn remote_control_get_token(
    state: State<'_, RemoteControlState>,
) -> Result<Option<String>, RemoteControlError> {
    let token = rc_keyring::read_token().map_err(RemoteControlError::Keyring)?;
    state.record_token_presence(token.is_some());
    Ok(token)
}

#[tauri::command]
pub async fn remote_control_rotate_token(
    state: State<'_, RemoteControlState>,
) -> Result<String, RemoteControlError> {
    let token = rc_keyring::generate_token();
    rc_keyring::write_token(&token).map_err(RemoteControlError::Keyring)?;
    state.record_token_presence(true);
    Ok(token)
}

#[tauri::command]
pub async fn remote_control_update_config(
    state: State<'_, RemoteControlState>,
    config: RemoteControlConfig,
) -> Result<(), RemoteControlError> {
    state.update_config(config);
    Ok(())
}

#[tauri::command]
pub async fn remote_control_set_signing_secret(
    state: State<'_, RemoteControlState>,
    secret: Option<String>,
) -> Result<(), RemoteControlError> {
    match secret {
        Some(value) if !value.is_empty() => {
            rc_keyring::write_signing_secret(&value).map_err(RemoteControlError::Keyring)?;
            state.record_signing_secret_presence(true);
        }
        _ => {
            rc_keyring::clear_signing_secret().map_err(RemoteControlError::Keyring)?;
            state.record_signing_secret_presence(false);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn remote_control_get_signing_secret() -> Result<Option<String>, RemoteControlError> {
    rc_keyring::read_signing_secret().map_err(RemoteControlError::Keyring)
}

/// Answer a GET read the inbound server requested via `remote-control://query`.
/// `payload` is the renderer's Dexie read result (already PII-gated). Unknown /
/// already-timed-out request ids are a silent no-op.
#[tauri::command]
pub async fn remote_control_query_response(
    state: State<'_, RemoteControlState>,
    request_id: String,
    payload: serde_json::Value,
) -> Result<(), RemoteControlError> {
    state.resolve_query(&request_id, payload);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote_control::types::RemoteControlConfig;

    #[tokio::test]
    async fn update_config_round_trips() {
        let state = RemoteControlState::new();
        let mut cfg = RemoteControlConfig::default();
        cfg.inbound.rate_limit_per_min = 120;
        // Tauri's State extractor isn't easy to fake in a unit test, so we
        // call the underlying state method directly. The command function is
        // covered by integration tests under `src-tauri/tests/` (if added)
        // and end-to-end via the renderer.
        state.update_config(cfg);
        assert_eq!(state.config().inbound.rate_limit_per_min, 120);
    }
}
