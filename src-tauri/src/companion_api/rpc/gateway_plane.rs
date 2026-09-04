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

pub(super) const COMMANDS: &[&str] = &[
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
    let Some(app) = state.app_handle.as_ref() else {
        return Err(no_gateway("gateway state is unavailable on this host"));
    };
    let Some(gateway) = app.try_state::<GatewayState>() else {
        return Err(no_gateway(
            "the LLM gateway has not been initialised on this desktop",
        ));
    };
    Ok(f(&gateway, "desktop"))
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
    account_id: Option<&str>,
    scope: Option<&str>,
) -> Result<Value, (StatusCode, Json<RpcError>)> {
    use tauri::Manager as _;
    let _ = (device_id, account_id, scope);
    match name {
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
                let Some(app) = state.app_handle.clone() else {
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

    #[test]
    fn command_family_is_closed() {
        assert_eq!(
            COMMANDS,
            &[
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
