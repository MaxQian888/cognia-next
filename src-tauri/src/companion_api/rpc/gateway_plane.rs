//! Gateway management plane over the shared dispatcher (ADR-0163 Phase 2).
//!
//! One namespace, two hosts. On the desktop the arms read the Tauri-managed
//! `GatewayState`. On `cognia-server` they read `HeadlessServices::gateway`.
//! The CLI bridge (`/api/dev/provider-operations/execute`) and the headless
//! `/internal/_rpc/{name}` route both land here, so a desktop and a server
//! answer the same command with the same shape.
//!
//! These are MANAGEMENT commands and they are deliberately not routes on the
//! gateway listener itself: that port is handed to Claude Code and Codex as
//! their base URL, and anything reachable there is reachable by the agent
//! subprocess. Minting a ticket, listing tickets and probing upstreams stay on
//! the planes that authenticate an operator, never on the agent's port.

use super::*;
use crate::gateway::GatewayState;
use std::sync::Arc;

pub(super) const COMMANDS: &[&str] = &[
    "agent_gateway_lease_prepare",
    "agent_gateway_lease_renew",
    "agent_gateway_lease_revoke",
    "gateway_status",
    "gateway_list_models",
    "gateway_provider_capabilities",
    "gateway_mint_route_ticket",
    "gateway_list_route_tickets",
    "gateway_revoke_route_ticket",
    "gateway_probe_upstream",
];

fn no_gateway(detail: &str) -> (StatusCode, Json<RpcError>) {
    RpcError::service_unavailable(detail.to_string())
}

/// The gateway this host owns, whichever host that is.
fn with_gateway<R>(
    state: &SharedState,
    host: &super::super::dispatch_host::DispatchHost,
    f: impl FnOnce(&GatewayState, &'static str) -> R,
) -> Result<R, (StatusCode, Json<RpcError>)> {
    use tauri::Manager as _;
    if let Some(services) = host.headless() {
        return Ok(f(&services.gateway, "headless"));
    }
    let Some(app) = crate::companion_api::host::tauri_app(&state.renderer) else {
        return Err(no_gateway("gateway state is unavailable on this host"));
    };
    let Some(gateway) = app.try_state::<GatewayState>() else {
        return Err(no_gateway(
            "the LLM gateway has not been initialised on this desktop",
        ));
    };
    Ok(f(&gateway, "desktop"))
}

/// Bind a remote process's gateway environment to its authenticated task lease.
/// Service callers retain the existing local gateway path.
pub(super) async fn authorize_task_agent_control(
    host: &super::super::dispatch_host::DispatchHost,
    device: &str,
    agent_id: &str,
) -> Result<(), (StatusCode, Json<RpcError>)> {
    let info = host
        .exec_backend()
        .get_info(agent_id)
        .await
        .map_err(RpcError::internal)?;
    if info
        .get("originDeviceId")
        .and_then(Value::as_str)
        .is_some_and(|owner| owner != device)
    {
        return Err(RpcError::forbidden(
            "agent process belongs to another paired device",
        ));
    }
    Ok(())
}

fn validate_task_endpoints(
    config: &crate::external_agent::process::ExternalAgentSpawnConfig,
    payload: &Value,
    endpoint: &str,
) -> Result<(), String> {
    crate::gateway::task_lease::validate_task_endpoints(
        &config.env,
        &config.args,
        payload,
        endpoint,
    )
}

pub(super) fn authorize_task_spawn(
    state: &SharedState,
    host: &super::super::dispatch_host::DispatchHost,
    device: &str,
    tenant: Option<&str>,
    scope: Option<&str>,
    config: &mut crate::external_agent::process::ExternalAgentSpawnConfig,
) -> Result<
    Option<cognia_external_agent::spawn_authority::GatewayAuthority>,
    (StatusCode, Json<RpcError>),
> {
    if scope == Some("service") || !config.env.contains_key("COGNIA_GATEWAY_TASK_CONFIG") {
        return Ok(None);
    }
    let mut payload: Value = serde_json::from_str(&config.env["COGNIA_GATEWAY_TASK_CONFIG"])
        .map_err(|_| RpcError::validation_failed("invalid gateway task payload".into()))?;
    let task = payload
        .get("taskId")
        .and_then(Value::as_str)
        .ok_or_else(|| RpcError::validation_failed("gateway task id is missing".into()))?;
    let secret = config
        .env
        .get("COGNIA_GATEWAY_TOKEN")
        .ok_or_else(|| RpcError::forbidden("gateway task lease is missing"))?;
    let tenant = tenant.ok_or_else(|| RpcError::forbidden("gateway task account is missing"))?;
    with_gateway(state, host, |gateway, _| {
        gateway.validate_task_secret(tenant, device, task, secret)
    })?
    .map_err(RpcError::forbidden)?;
    let endpoint = with_gateway(state, host, |gateway, _| gateway.status().bound_port)?
        .ok_or_else(|| RpcError::forbidden("gateway task listener is unavailable"))?;
    validate_task_endpoints(config, &payload, &format!("http://127.0.0.1:{endpoint}/v1"))
        .map_err(RpcError::forbidden)?;
    let gateway = with_gateway(state, host, |gateway, _| gateway.clone())?;
    let tenant = tenant.to_owned();
    let device_owned = device.to_owned();
    let task_owned = task.to_owned();
    let secret = secret.clone();
    let authority = cognia_external_agent::spawn_authority::GatewayAuthority {
        port: endpoint,
        device_id: Some(device.to_owned()),
        task_id: task.to_owned(),
        authorized: Arc::new(move || {
            gateway
                .validate_task_secret(&tenant, &device_owned, &task_owned, &secret)
                .is_ok()
        }),
    };
    payload["originDeviceId"] = Value::String(device.to_owned());
    config
        .env
        .insert("COGNIA_GATEWAY_TASK_CONFIG".into(), payload.to_string());
    Ok(Some(authority))
}

/// Everything the snapshot says a provider can do, from the gateway's point
/// of view: wire protocol, exposure, key pool and cooldown. This is what the
/// gateway KNOWS, not the operation contract's matrix (which lives in the
/// renderer and the CLI). A caller wanting cells asks `capabilities.read`.
fn provider_capabilities(gateway: &GatewayState) -> Value {
    let cooldowns = gateway.cooldowns();
    let config = gateway.config();
    gateway.with_snapshot(|snapshot| {
        let Some(snapshot) = snapshot else {
            return serde_json::json!({ "snapshot": false, "providers": [] });
        };
        let providers: Vec<Value> = snapshot
            .providers
            .iter()
            .map(|provider| {
                let on_cooldown = cooldowns
                    .iter()
                    .filter(|row| row.provider_id == provider.id)
                    .count();
                let pool = if provider.rotation_enabled && !provider.api_keys.is_empty() {
                    provider.api_keys.len()
                } else if provider.api_key.is_some() {
                    1
                } else {
                    0
                };
                let models: Vec<Value> = provider
                    .models
                    .iter()
                    .map(|model| {
                        let id = format!("{}:{}", provider.id, model);
                        serde_json::json!({
                            "id": model,
                            "exposed": config.model_is_exposed(&id) || config.model_is_exposed(model),
                        })
                    })
                    .collect();
                serde_json::json!({
                    "id": provider.id,
                    "protocol": provider.protocol,
                    "baseUrl": provider.base_url,
                    "enabled": provider.enabled,
                    "deploymentId": provider.deployment_id,
                    "credentialPool": pool,
                    "keysOnCooldown": on_cooldown,
                    "models": models,
                })
            })
            .collect();
        serde_json::json!({
            "snapshot": true,
            "generatedAtMs": snapshot.generated_at_ms,
            "profileVersion": snapshot.profile_version,
            "providers": providers,
        })
    })
}

/// Every model id the gateway will route: aliases first, then each enabled
/// provider's `provider:model` ids, each with the exposure verdict.
fn list_models(gateway: &GatewayState) -> Value {
    let config = gateway.config();
    gateway.with_snapshot(|snapshot| {
        let Some(snapshot) = snapshot else {
            return serde_json::json!({ "snapshot": false, "models": [] });
        };
        let mut models: Vec<Value> = snapshot
            .aliases
            .iter()
            .map(|alias| {
                serde_json::json!({
                    "id": alias.alias,
                    "kind": "alias",
                    "candidates": alias.entries.len(),
                    "exposed": config.model_is_exposed(&alias.alias),
                })
            })
            .collect();
        for provider in snapshot.providers.iter().filter(|p| p.enabled) {
            for model in &provider.models {
                let id = format!("{}:{}", provider.id, model);
                models.push(serde_json::json!({
                    "id": id,
                    "kind": "provider-model",
                    "providerId": provider.id,
                    "model": model,
                    "exposed": config.model_is_exposed(&id) || config.model_is_exposed(model),
                }));
            }
        }
        serde_json::json!({
            "snapshot": true,
            "generatedAtMs": snapshot.generated_at_ms,
            "models": models,
        })
    })
}

pub(super) async fn dispatch(
    name: &str,
    args: Value,
    state: &SharedState,
    host: &super::super::dispatch_host::DispatchHost,
    device_id: &str,
    tenant_id: Option<&str>,
    scope: Option<&str>,
) -> Result<Value, (StatusCode, Json<RpcError>)> {
    use tauri::Manager as _;
    let _ = (device_id, tenant_id, scope);
    match name {
        "agent_gateway_lease_prepare" => {
            let tenant = tenant_id.ok_or_else(|| {
                RpcError::forbidden("gateway task requires an authenticated account")
            })?;
            let mut request: crate::gateway::task_lease::TaskLeaseRequest =
                serde_json::from_value(args.get("request").cloned().unwrap_or(Value::Null))
                    .map_err(|_| {
                        RpcError::validation_failed("invalid gateway task request".into())
                    })?;
            let generation = with_gateway(state, host, |gateway, _| {
                gateway.status().account_generation
            })?;
            request.upstream_client = Some(
                crate::gateway::task_lease::validate_public_upstream(&request.provider.base_url)
                    .await
                    .map_err(RpcError::validation_failed)?,
            );
            let deny_list = Arc::clone(&state.deny_list);
            let authority_tenant = tenant.to_owned();
            let authority_device = device_id.to_owned();
            request.authority = Some(Arc::new(move || {
                !deny_list.is_revoked(&authority_tenant, &authority_device)
                    && crate::companion_api::security_store::security_store().is_some_and(|store| {
                        store
                            .has_capability(&authority_tenant, &authority_device, "process.spawn")
                            .unwrap_or(false)
                    })
            }));
            let lease = with_gateway(state, host, |gateway, _| {
                gateway.mint_task_lease(tenant, device_id, generation, request)
            })?
            .map_err(|_| {
                RpcError::validation_failed(
                    "invalid gateway task configuration or authority".into(),
                )
            })?;
            let start = if let Some(services) = host.headless() {
                if services.gateway.status().running {
                    Ok(())
                } else {
                    services
                        .gateway
                        .start_for_task(
                            Arc::new(crate::headless::gateway_host::HeadlessGatewayHost {
                                event_bus: Arc::clone(&state.event_bus),
                            }),
                            &lease.ticket_id,
                        )
                        .await
                }
            } else {
                let app = crate::companion_api::host::tauri_app(&state.renderer)
                    .ok_or_else(|| no_gateway("gateway host unavailable"))?;
                let gateway = app.state::<GatewayState>();
                if gateway.status().running {
                    Ok(())
                } else {
                    gateway
                        .start_for_task(
                            Arc::new(crate::gateway::host::TauriGatewayHost(app.clone())),
                            &lease.ticket_id,
                        )
                        .await
                }
            };
            let status = with_gateway(state, host, |gateway, _| gateway.status())?;
            if start.is_err() && !status.running
                || status.account_generation != generation
                || !status.running
            {
                with_gateway(state, host, |gateway, _| {
                    gateway.revoke_route_ticket(&lease.ticket_id)
                })?;
                return Err(no_gateway(
                    "task gateway listener failed or account changed",
                ));
            }
            let mut result =
                serde_json::to_value(lease).map_err(|e| RpcError::internal(e.to_string()))?;
            result["endpoint"] = Value::String(format!(
                "http://127.0.0.1:{}/v1",
                status
                    .bound_port
                    .ok_or_else(|| no_gateway("gateway port unavailable"))?
            ));
            Ok(result)
        }
        "agent_gateway_lease_renew" | "agent_gateway_lease_revoke" => {
            let tenant = tenant_id.ok_or_else(|| {
                RpcError::forbidden("gateway task requires an authenticated account")
            })?;
            let task: String = required(&args, "taskId")?;
            let ticket: String = required(&args, "ticketId")?;
            let generation: u64 = required(&args, "accountGeneration")?;
            with_gateway(state, host, |gateway, _| {
                gateway.control_task_lease(
                    tenant,
                    device_id,
                    &task,
                    &ticket,
                    generation,
                    name == "agent_gateway_lease_renew",
                )
            })?
            .map(Value::Bool)
            .map_err(RpcError::forbidden)
        }

        "gateway_status" => with_gateway(state, host, |gateway, host_kind| {
            let status = gateway.status();
            let now = chrono::Utc::now().timestamp_millis();
            let tickets = gateway.list_route_tickets();
            let active = tickets
                .iter()
                .filter(|ticket| ticket.expires_at_ms > now)
                .count();
            let mut value = serde_json::to_value(status).unwrap_or(Value::Null);
            if let Value::Object(ref mut map) = value {
                map.insert("host".into(), Value::String(host_kind.into()));
                map.insert("routeTickets".into(), Value::from(tickets.len()));
                map.insert("activeRouteTickets".into(), Value::from(active));
            }
            value
        }),

        "gateway_list_models" => with_gateway(state, host, |gateway, _| list_models(gateway)),

        "gateway_provider_capabilities" => {
            with_gateway(state, host, |gateway, _| provider_capabilities(gateway))
        }

        "gateway_mint_route_ticket" => {
            let request: crate::cli_bridge::provider_admin::BridgeTicketRequest =
                required(&args, "request")?;
            with_gateway(state, host, |gateway, _| {
                let minted =
                    crate::cli_bridge::provider_admin::mint_bridge_ticket(gateway, request)
                        .map_err(|(status, message)| match status {
                            StatusCode::SERVICE_UNAVAILABLE => {
                                RpcError::service_unavailable(message)
                            }
                            StatusCode::NOT_FOUND | StatusCode::BAD_REQUEST => {
                                RpcError::validation_failed(message)
                            }
                            _ => RpcError::internal(message),
                        })?;
                let status = gateway.status();
                let port = status.bound_port.filter(|_| status.running);
                let mut payload = serde_json::json!({
                    "ticket": minted.ticket,
                    "secret": minted.secret,
                });
                if let Some(port) = port {
                    payload["gatewayPort"] = Value::from(port);
                    payload["endpoint"] = Value::String(format!("http://127.0.0.1:{port}/v1"));
                }
                Ok(payload)
            })?
        }

        "gateway_list_route_tickets" => with_gateway(
            state,
            host,
            |gateway, _| serde_json::json!({ "tickets": gateway.list_route_tickets() }),
        ),

        "gateway_revoke_route_ticket" => {
            let ticket_id: String = required(&args, "ticketId")?;
            with_gateway(state, host, |gateway, _| {
                let revoked = gateway.revoke_route_ticket(&ticket_id);
                serde_json::json!({ "ticketId": ticket_id, "revoked": revoked })
            })
        }

        "gateway_probe_upstream" => {
            let model: String = required(&args, "model")?;
            // The probe is async, so hold the owning handle rather than a
            // borrowed guard across the await.
            let rows = if let Some(services) = host.headless() {
                services.gateway.probe_upstream(&model).await
            } else {
                let Some(app) = crate::companion_api::host::tauri_app(&state.renderer).cloned()
                else {
                    return Err(no_gateway("gateway state is unavailable on this host"));
                };
                let Some(gateway) = app.try_state::<GatewayState>() else {
                    return Err(no_gateway(
                        "the LLM gateway has not been initialised on this desktop",
                    ));
                };
                gateway.probe_upstream(&model).await
            }
            .map_err(RpcError::service_unavailable)?;
            serde_json::to_value(rows).map_err(|e| RpcError::internal(e.to_string()))
        }

        _ => Err(RpcError::unknown_command(name)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headless_host() -> super::super::super::dispatch_host::DispatchHost {
        super::super::super::dispatch_host::DispatchHost::Headless(
            crate::headless::HeadlessServices::stub_for_tests(),
        )
    }

    #[tokio::test]
    async fn malformed_task_credentials_never_enter_rpc_diagnostics() {
        let state = super::super::tests::test_state();
        let result = dispatch("agent_gateway_lease_prepare", serde_json::json!({"request": {
            "taskId":"task", "model":"model", "ingressProtocol":"openai-chat",
            "provider":{"id":"provider","protocol":"openai","baseUrl":"https://api.example.com","enabled":"fake-secret-must-not-leak","apiKey":"fake-key"}
        }}), &state, &headless_host(), "device", Some("tenant"), None).await;
        let (_, Json(error)) = result.unwrap_err();
        let message = serde_json::to_string(&error).unwrap();
        assert!(message.contains("invalid gateway task request"));
        assert!(!message.contains("fake-secret"));
        assert!(!message.contains("fake-key"));
    }

    #[test]
    fn task_launch_cannot_redirect_host_lease_credentials() {
        let mut config: crate::external_agent::process::ExternalAgentSpawnConfig =
            serde_json::from_value(
                serde_json::json!({"id":"task", "command":"codex", "args":[], "env":{}}),
            )
            .unwrap();
        let endpoint = "http://127.0.0.1:12345/v1";
        let payload = serde_json::json!({"files":{"codex/config.toml":"[model_providers.cognia]\nbase_url = \"http://127.0.0.1:12345/v1\""}});
        assert!(validate_task_endpoints(&config, &payload, endpoint).is_ok());
        config
            .env
            .insert("OPENAI_BASE_URL".into(), "http://127.0.0.1:8317/v1".into());
        assert!(validate_task_endpoints(&config, &payload, endpoint).is_err());
        config.env.clear();
        config.env.insert(
            "CODEX_CONFIG".into(),
            r#"{"model_providers":{"cognia":{"base_url":"https://elsewhere.test/v1"}}}"#.into(),
        );
        assert!(validate_task_endpoints(&config, &payload, endpoint).is_err());
    }

    #[test]
    fn command_family_is_closed() {
        assert_eq!(
            COMMANDS,
            &[
                "agent_gateway_lease_prepare",
                "agent_gateway_lease_renew",
                "agent_gateway_lease_revoke",
                "gateway_status",
                "gateway_list_models",
                "gateway_provider_capabilities",
                "gateway_mint_route_ticket",
                "gateway_list_route_tickets",
                "gateway_revoke_route_ticket",
                "gateway_probe_upstream",
            ]
        );
    }

    /// Every name the family advertises reaches an arm.
    ///
    /// A name in `COMMANDS` with no `match` arm falls through to the wildcard
    /// and answers `unknown_command`, which on a paired device is an
    /// indistinguishable 404: the command is allowlisted, authorised, routed,
    /// and then denied for not existing. The repository-wide parity gate
    /// catches that, but only for commands it can see, so the family pins it
    /// here too. Missing arguments are fine, and are the point: a validation
    /// failure proves the arm ran.
    #[tokio::test]
    async fn every_advertised_command_reaches_an_arm() {
        let state = super::super::tests::test_state();
        let host = headless_host();
        for name in COMMANDS {
            let outcome = dispatch(
                name,
                serde_json::json!({}),
                &state,
                &host,
                "device-a",
                None,
                None,
            )
            .await;
            if let Err((_, Json(error))) = outcome {
                assert_ne!(
                    error.code, "unknown_command",
                    "{name} is advertised in COMMANDS but has no dispatch arm"
                );
            }
        }
    }

    #[tokio::test]
    async fn a_name_outside_the_family_is_refused() {
        let state = super::super::tests::test_state();
        let host = headless_host();
        let (_, Json(error)) = dispatch(
            "gateway_not_a_command",
            serde_json::json!({}),
            &state,
            &host,
            "device-a",
            None,
            None,
        )
        .await
        .expect_err("an unknown name must be refused, not answered");
        assert_eq!(error.code, "unknown_command");
    }

    /// Before the first profile lands there is no snapshot, and both
    /// projections have to say so rather than claim an empty gateway. A caller
    /// that cannot tell "no providers configured" from "not loaded yet" would
    /// render an empty list as a finished answer.
    #[test]
    fn the_projections_report_a_missing_snapshot_rather_than_an_empty_one() {
        let services = crate::headless::HeadlessServices::stub_for_tests();
        let models = list_models(&services.gateway);
        assert_eq!(models["snapshot"], serde_json::json!(false));
        assert_eq!(models["models"], serde_json::json!([]));

        let capabilities = provider_capabilities(&services.gateway);
        assert_eq!(capabilities["snapshot"], serde_json::json!(false));
        assert_eq!(capabilities["providers"], serde_json::json!([]));
    }

    /// The three situations `with_gateway` distinguishes collapse into one
    /// status on purpose: a caller can retry a 503, and neither "this host has
    /// no app handle" nor "the desktop never initialised the gateway" is the
    /// caller's fault.
    #[test]
    fn an_absent_gateway_is_a_service_failure_not_a_bad_request() {
        let (status, Json(error)) = no_gateway("nothing here");
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(error.code, "service_unavailable");
        assert_eq!(error.message, "nothing here");
    }
}
