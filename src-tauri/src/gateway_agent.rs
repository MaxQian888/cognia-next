//! Desktop adapter between the sibling gateway and external-agent crates.
//! The app owns both states; no execution backend reads renderer credentials.
use crate::{external_agent, gateway};
use external_agent::process::ExternalAgentSpawnConfig;
use external_agent::spawn_authority::{with_gateway, GatewayAuthority};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};

fn authorize(
    config: &mut ExternalAgentSpawnConfig,
    gateway: &gateway::GatewayState,
) -> Result<Option<GatewayAuthority>, String> {
    let Some(raw) = config.env.get(external_agent::gateway_task::PAYLOAD_ENV) else {
        return Ok(None);
    };
    let mut payload: serde_json::Value =
        serde_json::from_str(raw).map_err(|_| "Invalid gateway task configuration")?;
    let task = payload
        .get("taskId")
        .and_then(serde_json::Value::as_str)
        .ok_or("Missing gateway task identity")?
        .to_owned();
    let owner = match payload.get("ownerAccountId") {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(owner)) => Some(owner.clone()),
        _ => return Err("Invalid gateway task account".into()),
    };
    let secret = config
        .env
        .get("COGNIA_GATEWAY_TOKEN")
        .ok_or("Missing gateway task lease")?
        .clone();
    let status = gateway.status();
    let port = status
        .bound_port
        .ok_or("The local gateway listener is unavailable")?;
    let generation = status.account_generation;
    gateway.validate_local_task_secret(&task, owner.as_deref(), generation, port, &secret)?;
    gateway::task_lease::validate_task_endpoints(
        &config.env,
        &config.args,
        &payload,
        &format!("http://127.0.0.1:{port}/v1"),
    )?;
    // A desktop IPC caller cannot manufacture a paired-device history owner.
    payload
        .as_object_mut()
        .ok_or("Invalid gateway task configuration")?
        .remove("originDeviceId");
    config.env.insert(
        external_agent::gateway_task::PAYLOAD_ENV.into(),
        payload.to_string(),
    );
    let gateway = gateway.clone();
    let task_id = task.clone();
    Ok(Some(GatewayAuthority {
        port,
        device_id: None,
        task_id,
        authorized: Arc::new(move || {
            gateway
                .validate_local_task_secret(&task, owner.as_deref(), generation, port, &secret)
                .is_ok()
        }),
    }))
}

/// Same execution command and policy as remote/native spawns. Only this
/// desktop adapter can bind a local ticket to the server-owned gateway state.
#[tauri::command]
pub async fn spawn_external_agent(
    mut config: ExternalAgentSpawnConfig,
    state: State<'_, external_agent::commands::ExternalAgentState>,
    app: AppHandle,
) -> Result<String, String> {
    let authority = if config
        .env
        .contains_key(external_agent::gateway_task::PAYLOAD_ENV)
    {
        let gateway = app
            .try_state::<gateway::GatewayState>()
            .ok_or("The local gateway state is unavailable")?;
        authorize(&mut config, &gateway)?
    } else {
        None
    };
    with_gateway(
        authority,
        external_agent::commands::spawn_external_agent(config, state, app),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> ExternalAgentSpawnConfig {
        serde_json::from_value(serde_json::json!({"id":"task","command":"claude-agent-acp","args":[],"env":{},"cwd":null})).unwrap()
    }
    #[test]
    fn native_agent_without_gateway_retains_existing_path() {
        let state = gateway::GatewayState::new();
        assert!(authorize(&mut config(), &state).unwrap().is_none());
    }
    #[test]
    fn desktop_payload_cannot_supply_missing_gateway_authority() {
        let state = gateway::GatewayState::new();
        let mut input = config();
        input.env.insert(external_agent::gateway_task::PAYLOAD_ENV.into(),serde_json::json!({"taskId":"task","ownerAccountId":"invented","originDeviceId":"invented-device","runtime":"claude","binding":{},"files":{}}).to_string());
        input
            .env
            .insert("COGNIA_GATEWAY_TOKEN".into(), "invented-secret".into());
        assert!(authorize(&mut input, &state).is_err());
    }
}
