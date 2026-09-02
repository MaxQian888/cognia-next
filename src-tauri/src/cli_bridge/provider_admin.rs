//! Provider admin leg of the CLI bridge (ADR-0163 Phase 2).
//!
//! The management plane is deliberately NOT on the gateway listener: that
//! port is handed to Claude Code and Codex as their base URL, so anything
//! reachable there is reachable by an agent subprocess and by anything that
//! can read its environment. Admin operations ride the two control planes
//! that already authenticate, sharing one dispatcher:
//!   - desktop running: this bridge (`X-Cognia-Dev-Token`, loopback),
//!   - `cognia-server` running: `POST /internal/_rpc/{name}` (service scope).
//!
//! This module holds the allowlist, the projection of the operation manifest,
//! and the pure decisions the three thin route bodies in `handlers.rs` make.
//! Everything here is testable without a Tauri app.

use axum::http::StatusCode;
use cognia_gateway::route_ticket::{MintRequest, MintedTicket, TicketAffinity, TicketBudget, TicketOperation};
use cognia_gateway::GatewayState;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::companion_api::command_manifest::{
    self, CommandApproval, CommandDescriptor, CommandOperation, CommandRisk,
};
use crate::companion_api::middleware::DeviceContext;

/// Tenant + device the bridge's provider admin calls run as. A service
/// principal: `remote_execution` grants service scope every capability and
/// admits it on the Internal transport, so the allowlist below is the entire
/// authorization boundary.
pub const PROVIDER_ADMIN_ACCOUNT_ID: &str = "cli-bridge";
pub const PROVIDER_ADMIN_DEVICE_ID: &str = "cli-bridge-provider-admin";
pub const PROVIDER_ADMIN_DISPLAY_NAME: &str = "Cognia CLI provider admin";

/// Commands the bridge exposes. Every entry must be a `read` operation of
/// `low` risk needing `none` approval (pinned by
/// `provider_admin_allowlist_is_read_only_and_low_risk`), which is what stops
/// this list from quietly becoming a privilege escalation path. The
/// `gateway_*` entries are the read half of the gateway management plane
/// (ADR-0163): minting, revoking and probing stay off this leg because they
/// are side effects, and the mint has its own dedicated bridge route.
pub const PROVIDER_ADMIN_COMMANDS: &[&str] = &[
    "provider_catalog_status",
    "provider_catalog_search",
    "provider_diagnostics_status",
    "provider_diagnostics_history",
    "gateway_status",
    "gateway_list_models",
    "gateway_provider_capabilities",
    "gateway_list_route_tickets",
];

#[derive(Debug, PartialEq, Eq)]
pub enum ProviderAdminReject {
    /// Not on the allowlist (the normal 403).
    NotExposed,
    /// On the allowlist but the manifest no longer classifies it as a
    /// low-risk read. Defence in depth: the static test should have caught
    /// it, the runtime refuses anyway.
    NotLowRiskRead,
}

impl ProviderAdminReject {
    pub fn status(&self) -> StatusCode {
        StatusCode::FORBIDDEN
    }

    pub fn code(&self) -> &'static str {
        match self {
            Self::NotExposed => "command_not_exposed",
            Self::NotLowRiskRead => "command_not_low_risk_read",
        }
    }
}

fn is_low_risk_read(descriptor: &CommandDescriptor) -> bool {
    descriptor.operation == CommandOperation::Read
        && descriptor.risk == CommandRisk::Low
        && descriptor.approval == CommandApproval::None
}

/// The gate every `provider_execute` call passes before dispatch.
pub fn authorize_provider_command(
    name: &str,
) -> Result<&'static CommandDescriptor, ProviderAdminReject> {
    if !PROVIDER_ADMIN_COMMANDS.contains(&name) {
        return Err(ProviderAdminReject::NotExposed);
    }
    let descriptor = command_manifest::descriptor(name).ok_or(ProviderAdminReject::NotExposed)?;
    if !is_low_risk_read(descriptor) {
        return Err(ProviderAdminReject::NotLowRiskRead);
    }
    Ok(descriptor)
}

/// The principal the bridge dispatches as. Service scope, no snapshot: the
/// security store's service principal (ensured by the handler) is the
/// authority.
pub fn provider_admin_principal() -> DeviceContext {
    DeviceContext {
        device_id: PROVIDER_ADMIN_DEVICE_ID.to_string(),
        account_id: PROVIDER_ADMIN_ACCOUNT_ID.to_string(),
        scope: "service".to_string(),
        granted_scopes: Vec::new(),
        authorization_capabilities: None,
    }
}

/// The capabilities the allowlisted commands name, for the service principal
/// row. Service scope does not consult them, but the row is honest.
pub fn provider_admin_capabilities() -> Vec<&'static str> {
    let mut out: Vec<&'static str> = PROVIDER_ADMIN_COMMANDS
        .iter()
        .filter_map(|name| command_manifest::descriptor(name))
        .map(|descriptor| descriptor.capability.as_str())
        .collect();
    out.sort_unstable();
    out.dedup();
    out
}

/// `protocol/provider-operations.json`, served verbatim so a CLI can probe
/// what this desktop knows before choosing a verb. Compiled in: the bridge
/// must answer without a renderer.
pub fn operation_manifest_projection() -> Value {
    static MANIFEST: &str = include_str!("../../../protocol/provider-operations.json");
    let manifest: Value = serde_json::from_str(MANIFEST)
        .expect("protocol/provider-operations.json must be valid JSON");
    json!({
        "ok": true,
        "schemaVersion": manifest["schemaVersion"],
        "operations": manifest["operations"],
        "adminCommands": PROVIDER_ADMIN_COMMANDS,
    })
}

// ---- route tickets -----------------------------------------------------------------

/// `POST /api/dev/gateway/route-ticket` body. Candidates and bindings are
/// derived Rust-side from `model` (`route_planner::candidates_for_model` and
/// `default_model_bindings`), so the CLI only names the model it wants.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeTicketRequest {
    pub model: String,
    pub session_id: String,
    #[serde(default)]
    pub parent_session_id: Option<String>,
    pub execution_fingerprint: String,
    pub route_policy: String,
    #[serde(default)]
    pub ttl_ms: Option<i64>,
    #[serde(default)]
    pub operations: Option<Vec<TicketOperation>>,
    #[serde(default)]
    pub budget: Option<TicketBudget>,
}

/// Mint against the desktop gateway's CURRENT snapshot. Not gated on the
/// renderer's `gatewayAgentRouteTickets` execution-spec flag: that flag
/// describes the renderer's own send path, and the CLI may have no renderer
/// at all. Gating here would silently reproduce the 401 this leg exists to
/// fix.
pub fn mint_bridge_ticket(
    gateway: &GatewayState,
    request: BridgeTicketRequest,
) -> Result<MintedTicket, (StatusCode, String)> {
    let candidates = match gateway.ticket_candidates_for_model(&request.model) {
        Ok(candidates) => candidates,
        Err(_) => {
            return Err((
                StatusCode::SERVICE_UNAVAILABLE,
                "gateway has no routing snapshot yet — open the Cognia window once so it can publish providers".to_string(),
            ));
        }
    };
    if candidates.is_empty() {
        return Err((
            StatusCode::NOT_FOUND,
            format!(
                "model \"{}\" matches no alias, provider:model, or enabled provider model",
                request.model
            ),
        ));
    }
    // More than one candidate means failover is possible, so the ticket must
    // permit moving off the first credential. Same rule as the renderer's
    // `mintSessionRouteTicket`.
    let failover = candidates.len() > 1;
    let mint = MintRequest {
        session_id: request.session_id,
        parent_session_id: request.parent_session_id,
        execution_fingerprint: request.execution_fingerprint,
        candidates,
        model_bindings: Default::default(),
        credential_affinity: if failover {
            TicketAffinity::StickyWithFailover
        } else {
            TicketAffinity::SessionSticky
        },
        allow_auth_failover: failover,
        route_policy: request.route_policy,
        ttl_ms: request.ttl_ms,
        model: Some(request.model),
        operations: request.operations,
        budget: request.budget,
    };
    gateway.mint_route_ticket(mint).map_err(|error| {
        let status = match error {
            cognia_gateway::route_ticket::TicketError::WidenedRemint { .. } => StatusCode::CONFLICT,
            cognia_gateway::route_ticket::TicketError::NoSnapshot => StatusCode::SERVICE_UNAVAILABLE,
            _ => StatusCode::BAD_REQUEST,
        };
        (status, error.to_string())
    })
}

/// The wire shape the CLI consumes. The secret appears ONCE.
pub fn bridge_ticket_payload(minted: &MintedTicket, gateway_port: u16) -> Value {
    json!({
        "ok": true,
        "endpoint": format!("http://127.0.0.1:{gateway_port}/v1"),
        "ticket": minted.ticket,
        "secret": minted.secret,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_admin_allowlist_is_read_only_and_low_risk() {
        assert!(!PROVIDER_ADMIN_COMMANDS.is_empty());
        for name in PROVIDER_ADMIN_COMMANDS {
            let descriptor = command_manifest::descriptor(name)
                .unwrap_or_else(|| panic!("{name} is not in protocol/companion-commands.json"));
            assert_eq!(descriptor.operation, CommandOperation::Read, "{name}");
            assert_eq!(descriptor.risk, CommandRisk::Low, "{name}");
            assert_eq!(descriptor.approval, CommandApproval::None, "{name}");
            assert!(authorize_provider_command(name).is_ok(), "{name}");
        }
    }

    #[test]
    fn provider_execute_rejects_unlisted_and_mutating_commands() {
        // A real, existing mutation must never be reachable through this leg.
        assert_eq!(
            authorize_provider_command("provider_profiles_import").unwrap_err(),
            ProviderAdminReject::NotExposed
        );
        assert_eq!(
            authorize_provider_command("gateway_create_key").unwrap_err(),
            ProviderAdminReject::NotExposed
        );
        assert_eq!(
            authorize_provider_command("no_such_command").unwrap_err(),
            ProviderAdminReject::NotExposed
        );
        assert_eq!(ProviderAdminReject::NotExposed.status(), StatusCode::FORBIDDEN);
        assert_eq!(ProviderAdminReject::NotExposed.code(), "command_not_exposed");
    }

    #[test]
    fn principal_is_service_scoped_and_capabilities_are_projected() {
        let principal = provider_admin_principal();
        assert_eq!(principal.scope, "service");
        assert_eq!(principal.device_id, PROVIDER_ADMIN_DEVICE_ID);
        let caps = provider_admin_capabilities();
        assert!(!caps.is_empty());
        assert!(caps.windows(2).all(|w| w[0] < w[1]), "sorted + deduped");
    }

    #[test]
    fn manifest_projection_serves_every_operation() {
        let projection = operation_manifest_projection();
        assert_eq!(projection["ok"], true);
        assert_eq!(projection["schemaVersion"], 1);
        assert!(projection["operations"].as_array().unwrap().len() >= 47);
        assert_eq!(
            projection["adminCommands"].as_array().unwrap().len(),
            PROVIDER_ADMIN_COMMANDS.len()
        );
    }

    fn ticket_request(model: &str) -> BridgeTicketRequest {
        serde_json::from_value(json!({
            "model": model,
            "sessionId": "s-bridge",
            "executionFingerprint": "aexf1-bridge",
            "routePolicy": "gateway-required",
        }))
        .unwrap()
    }

    #[test]
    fn gateway_route_ticket_without_snapshot_is_503() {
        let gateway = GatewayState::new();
        let (status, message) = mint_bridge_ticket(&gateway, ticket_request("glm-4.6")).unwrap_err();
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert!(message.contains("no routing snapshot"), "{message}");
    }

    #[test]
    fn gateway_route_ticket_derives_candidates_and_family_bindings() {
        let gateway = GatewayState::new();
        let snapshot: cognia_gateway::snapshot::RoutingSnapshot = serde_json::from_value(json!({
            "aliases": [],
            "providers": [{
                "id": "dep-a", "protocol": "anthropic", "baseUrl": "http://127.0.0.1:1/v1",
                "apiKey": "sk-up", "enabled": true,
                "models": ["claude-opus-5", "claude-haiku-4-5-20251001"],
                "deploymentId": "dep-a"
            }],
            "generatedAtMs": 1, "profileVersion": 1, "authority": "renderer"
        }))
        .unwrap();
        gateway.set_snapshot(snapshot);

        let unknown = mint_bridge_ticket(&gateway, ticket_request("gpt-nope")).unwrap_err();
        assert_eq!(unknown.0, StatusCode::NOT_FOUND);

        let minted = mint_bridge_ticket(&gateway, ticket_request("claude-opus-5")).unwrap();
        assert_eq!(minted.ticket.candidates.len(), 1);
        assert_eq!(minted.ticket.model_bindings["haiku"], "claude-haiku-4-5-20251001");
        assert_eq!(minted.ticket.credential_affinity, TicketAffinity::SessionSticky);
        assert!(!minted.ticket.allow_auth_failover);
        assert_eq!(
            minted.ticket.operations,
            cognia_gateway::route_ticket::default_ticket_operations()
        );

        let payload = bridge_ticket_payload(&minted, 47823);
        assert_eq!(payload["endpoint"], "http://127.0.0.1:47823/v1");
        assert_eq!(payload["secret"], minted.secret);
        assert_eq!(payload["ticket"]["ticketId"], minted.ticket.ticket_id);
    }
}
