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
        delivery_source: None,
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
    let mut authority = if config
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
    if config.env.contains_key(external_agent::spawn_authority::DELIVERY_SOURCE_ENV) {
        let source_authority = authority.as_mut().ok_or("delivery_source_gateway_required")?;
        let binding = crate::companion_api::host_identity::current().map_err(|error| error.to_string())?;
        let owner = crate::companion_api::host_identity::namespace_for_tenant(&binding.remote_tenant_id)
            .ok_or("delivery_source_account_required")?;
        let directory = app.path().app_data_dir().map_err(|e| e.to_string())?.join("cognia");
        let task = source_authority.task_id.clone();
        let (next_config, source) = tokio::task::spawn_blocking(move || {
            let host_id = crate::headless::deployment_id::resolve(&directory)?;
            let source = cognia_companion_rpc::delivery_admission::consume(
                &directory, &owner, &host_id, "local-desktop", &task, &mut config)?;
            Ok::<_, String>((config, source))
        }).await.map_err(|_| "delivery_source_admission_failed".to_string())??;
        config = next_config;
        source_authority.delivery_source = source;
        if !(source_authority.authorized)() { return Err("delivery_source_authority_revoked".into()); }
    }
    with_gateway(
        authority,
        external_agent::commands::spawn_external_agent(config, state, app),
    )
    .await
}

/// Native task deletion permanently fences any delivery produced by that task.
#[tauri::command]
pub async fn external_agent_delete_gateway_task(
    task_id: String,
    state: State<'_, external_agent::commands::ExternalAgentState>,
    app: AppHandle,
) -> Result<(), String> {
    let backend = state.exec();
    cognia_companion_rpc::delivery_admission::delete_with_source_fence(
        external_agent::commands::authorize_gateway_task_deletion(&task_id, backend.as_ref(), None),
        async {
            let directory = app.path().app_data_dir().map_err(|e| e.to_string())?.join("cognia");
            let source_store = cognia_sandbox_pool::provenance::SourceStore::new(&directory);
            let reader = source_store.clone();
            let task = task_id.clone();
            let has_source = tokio::task::spawn_blocking(move || reader.has_task(&task))
                .await.map_err(|_| "delivery_source_unavailable".to_string())??;
            if !has_source { return Ok(()); }
            let binding = crate::companion_api::host_identity::current().map_err(|error| error.to_string())?;
            let owner = crate::companion_api::host_identity::namespace_for_tenant(&binding.remote_tenant_id)
                .ok_or("delivery_source_account_required")?;
            let task = task_id.clone();
            tokio::task::spawn_blocking(move || {
                let host_id = crate::headless::deployment_id::resolve(&directory)?;
                source_store.revoke_owned_task(&owner, &host_id, &task, Some("local-desktop"))
            }).await.map_err(|_| "delivery_source_revocation_failed".to_string())?
        },
        async {
            let directory = app.path().app_data_dir().map_err(|e| e.to_string())?.join("cognia");
            let owner = crate::companion_api::host_identity::current().ok()
                .and_then(|binding| crate::companion_api::host_identity::namespace_for_tenant(&binding.remote_tenant_id));
            let root = directory.clone();
            let host_id = tokio::task::spawn_blocking(move || crate::headless::deployment_id::resolve(&root))
                .await.map_err(|_| "delivery_source_unavailable".to_string())??;
            let admission = cognia_companion_rpc::managed_desktops::task_deletion_admission(
                cognia_companion_rpc::managed_desktops::Caller { device_id:"local-desktop",tenant_id:None,scope:None,local:true },
                host_id.clone(),owner.clone());
            cognia_companion_rpc::managed_desktop_results::delete_task_history(&directory, owner, host_id, task_id.clone(), None, admission,
                external_agent::commands::delete_gateway_task_for_backend(&task_id, backend.as_ref())).await
        },
    ).await

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
