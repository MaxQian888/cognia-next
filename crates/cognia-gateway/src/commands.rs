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
    let host: std::sync::Arc<dyn crate::host::GatewayHost> =
        std::sync::Arc::new(crate::host::TauriGatewayHost(app));
    state.start(host).await.map_err(Into::into)
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
    quota_tokens: Option<i64>,
) -> Result<GatewayApiKey, String> {
    state
        .create_key(
            name,
            model_allowlist,
            expires_at_ms,
            rate_limit_per_min,
            quota_tokens,
        )
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

/// Zero a key's consumed-quota counter (the "reset usage" action).
#[tauri::command]
pub async fn gateway_reset_key_quota(
    state: State<'_, GatewayState>,
    id: String,
) -> Result<(), String> {
    state.reset_key_quota(&id).map_err(Into::into)
}

/// Reveal a key's full secret (explicit user action — copy/rotate flow).
#[tauri::command]
pub async fn gateway_reveal_key(
    state: State<'_, GatewayState>,
    id: String,
) -> Result<Option<String>, String> {
    Ok(state.reveal_key(&id))
}

/// Push result surfaced to the renderer so a rejected push (stale version /
/// authority conflict — R3) can reload the profile store and retry instead of
/// silently believing it published.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushSnapshotResult {
    pub accepted: bool,
    pub profile_version: Option<u64>,
    pub reason: Option<String>,
}

/// Push the renderer's latest routing+credential snapshot into the live
/// server. The snapshot carries API keys — they stay in Rust memory only.
/// Ingest is authority-checked (ADR-0090 Phase 2): stale or conflicting
/// versions are refused and the previous snapshot keeps serving.
#[tauri::command]
pub async fn gateway_push_snapshot(
    state: State<'_, GatewayState>,
    snapshot: RoutingSnapshot,
) -> Result<PushSnapshotResult, String> {
    match state.try_set_snapshot(snapshot) {
        Ok(accepted) => Ok(PushSnapshotResult {
            accepted: true,
            profile_version: accepted.profile_version,
            reason: None,
        }),
        Err(rejected) => Ok(PushSnapshotResult {
            accepted: false,
            profile_version: None,
            reason: Some(rejected.to_string()),
        }),
    }
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

// ---- Route tickets (ADR-0090 Phase 2) ---------------------------------------

/// Mint a session-scoped route ticket. The response carries the secret ONCE;
/// callers stamp it into the subprocess env (`ANTHROPIC_API_KEY`) and it is
/// never persisted or logged. Renderer-side the call is gated behind the
/// `gatewayAgentRouteTickets` feature flag.
#[tauri::command]
pub async fn gateway_mint_route_ticket(
    state: State<'_, GatewayState>,
    request: super::route_ticket::MintRequest,
) -> Result<super::route_ticket::MintedTicket, String> {
    state.mint_route_ticket(request).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn gateway_revoke_route_ticket(
    state: State<'_, GatewayState>,
    ticket_id: String,
) -> Result<bool, String> {
    Ok(state.revoke_route_ticket(&ticket_id))
}

/// Redacted ticket metadata for the settings/audit surface.
#[tauri::command]
pub async fn gateway_list_route_tickets(
    state: State<'_, GatewayState>,
) -> Result<Vec<super::route_ticket::RouteTicket>, String> {
    Ok(state.list_route_tickets())
}

/// List the pooled upstream keys currently cooling (429/529) or permanently
/// disabled (401 / quota — W1.1 + W3.1), for the settings surface. Secrets are
/// fingerprinted, never returned in full.
#[tauri::command]
pub async fn gateway_list_cooldowns(
    state: State<'_, GatewayState>,
) -> Result<Vec<super::cooldown::CooldownRow>, String> {
    Ok(state.cooldowns())
}

/// Run the upstream self-check for `model` and return one row per candidate.
///
/// Each row is a real, billable upstream call, so this is only ever invoked
/// from an explicit user action in Settings → Gateway → Overview.
#[tauri::command]
pub async fn gateway_probe_upstream(
    state: State<'_, GatewayState>,
    model: String,
) -> Result<Vec<super::server::UpstreamProbeResult>, String> {
    state.probe_upstream(&model).await
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
        let _guard = super::super::api_keys::STORE_TEST_GUARD
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let state = GatewayState::new();
        state.keys.write().clear();
        state.refresh_key_presence();
        let key = state
            .create_key("cli".into(), vec![], None, None, None)
            .unwrap();
        assert!(state.list_keys().iter().any(|k| k.id == key.id));
        state.delete_key(&key.id).unwrap();
        assert!(!state.list_keys().iter().any(|k| k.id == key.id));
    }
}
