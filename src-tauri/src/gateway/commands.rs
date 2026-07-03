//! Tauri commands for the inbound gateway. Each mirrors a function in
//! `lib/tauri/gateway.ts` 1:1.

use tauri::{AppHandle, State};

use super::api_keys::{ApiKeyPatch, GatewayApiKey, RedactedApiKey};
use super::snapshot::RoutingSnapshot;
use super::types::{GatewayConfig, GatewayStatus};
use super::GatewayState;

#[tauri::command]
pub async fn gateway_get_status(state: State<'_, GatewayState>) -> Result<GatewayStatus, String> {
    Ok(state.status())
}

/// Read the persisted config so the settings UI hydrates from the saved values
/// (port, allowlist, timeouts, retry policy, model exposure, bind interface)
/// rather than the compile-time defaults.
#[tauri::command]
pub async fn gateway_get_config(state: State<'_, GatewayState>) -> Result<GatewayConfig, String> {
    Ok(state.config())
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

// ---- API key management -----------------------------------------------------

/// List keys with secrets redacted (the settings UI shows a fingerprint only).
#[tauri::command]
pub async fn gateway_list_keys(
    state: State<'_, GatewayState>,
) -> Result<Vec<RedactedApiKey>, String> {
    Ok(state.list_keys())
}

/// Create a new key. Returns the FULL key (secret included) so the UI can show
/// it once for copying — subsequent lists are redacted.
#[tauri::command]
pub async fn gateway_create_key(
    state: State<'_, GatewayState>,
    name: String,
    model_allowlist: Vec<String>,
    expires_at_ms: Option<i64>,
    rate_limit_per_min: Option<u32>,
) -> Result<GatewayApiKey, String> {
    state
        .create_key(name, model_allowlist, expires_at_ms, rate_limit_per_min)
        .map_err(Into::into)
}

#[tauri::command]
pub async fn gateway_update_key(
    state: State<'_, GatewayState>,
    id: String,
    patch: ApiKeyPatch,
) -> Result<(), String> {
    state.update_key(&id, patch).map_err(Into::into)
}

#[tauri::command]
pub async fn gateway_delete_key(state: State<'_, GatewayState>, id: String) -> Result<(), String> {
    state.delete_key(&id).map_err(Into::into)
}

/// Reveal a key's full secret (explicit user action — copy/rotate flow).
#[tauri::command]
pub async fn gateway_reveal_key(
    state: State<'_, GatewayState>,
    id: String,
) -> Result<Option<String>, String> {
    Ok(state.reveal_key(&id))
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
    fn create_then_delete_key_via_state() {
        let state = GatewayState::new();
        state.keys.write().clear();
        state.refresh_key_presence();
        let key = state.create_key("cli".into(), vec![], None, None).unwrap();
        assert!(state.list_keys().iter().any(|k| k.id == key.id));
        state.delete_key(&key.id).unwrap();
        assert!(!state.list_keys().iter().any(|k| k.id == key.id));
    }
}
