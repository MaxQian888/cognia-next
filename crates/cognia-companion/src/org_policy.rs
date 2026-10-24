//! Tenant org administration shared by both command planes. This is a separate
//! module so no secret values or tenant scope enter the operator secret arms.
use axum::{extract::{Path, State, rejection::JsonRejection}, http::{HeaderMap, StatusCode}, response::{IntoResponse, Response}, Extension, Json};
use cognia_problem::Problem;
use serde::Deserialize;
use serde_json::{json, Value};
use crate::{deployment::{deployment_mode, DeploymentMode}, middleware::DeviceContext, org_credentials::OrgCredentials, rpc_error::RpcError, SharedState};

pub const CAPABILITY: &str = "org.policy.manage";
pub const COMMANDS: &[&str] = &["org_model_credential_list", "org_model_credential_set", "org_model_credential_delete", "org_agent_policy_get", "org_agent_policy_set"];
tokio::task_local! { static AUTHORITY: Option<(String, String)>; }
pub fn current_authority() -> Option<(String, String)> { AUTHORITY.try_with(Clone::clone).ok().flatten() }
pub async fn scope<T>(authority: Option<(String, String)>, future: impl std::future::Future<Output = T>) -> T {
    AUTHORITY.scope(authority, future).await
}
pub fn is_write(command: &str) -> bool {
    matches!(command, "org_model_credential_set" | "org_model_credential_delete" | "org_agent_policy_set")
}

pub fn require_mode(mode: DeploymentMode) -> Result<(), Problem> {
    if mode == DeploymentMode::MultiTenant { Ok(()) } else {
        // A configuration boundary, not a transient outage: retry cannot help.
        Err(Problem::with_status(StatusCode::CONFLICT, "org_scope_unavailable", "organization administration requires a multi-tenant Host"))
    }
}

/// Service authority must name an org; tenant devices may never select one.
pub async fn caller(args: &Value, principal: &DeviceContext) -> Result<(String, String), Problem> {
    caller_in_mode(deployment_mode(), args, principal).await
}

async fn caller_in_mode(mode: DeploymentMode, args: &Value, principal: &DeviceContext) -> Result<(String, String), Problem> {
    require_mode(mode)?;
    if crate::jwt::is_service_scope(Some(&principal.scope)) {
        let org = args.get("orgId").and_then(Value::as_str).ok_or_else(||
            Problem::with_status(StatusCode::BAD_REQUEST, "malformed_request", "orgId is required for service scope"))?;
        crate::org_credentials::validate_org(org).map_err(|_| Problem::with_status(StatusCode::BAD_REQUEST, "malformed_request", "invalid organization id"))?;
        return Ok((org.into(), "operator".into()));
    }
    if args.get("orgId").is_some() || args.get("org_id").is_some() {
        return Err(Problem::with_status(StatusCode::FORBIDDEN, "host_surface_forbidden", "tenant callers cannot select an organization"));
    }
    let person = crate::host_surface_gate::org_policy_person(principal).await?;
    let authority = (person.org, person.user);
    if current_authority().is_some_and(|admitted| admitted != authority) {
        return Err(Problem::with_status(StatusCode::FORBIDDEN, "host_principal_unbound", "organization binding changed during the request"));
    }
    Ok(authority)
}

/// The existing Host consent queue lets org admins request approval without
/// becoming Host operators or minting globally powerful admin leases.
pub async fn authorize_request(state: &SharedState, request: &crate::remote_execution::ExecutionRequest) -> Result<(), Problem> {
    let (org, _) = caller(&request.args, &request.principal).await?;
    let result = approve_write(&request.command, &org, &request.principal, &request.args);
    if let Err(problem) = &result {
        if problem.code == "interactive_approval_required" {
            state.event_bus.publish(crate::host_consent::CONSENT_CHANNEL.into(), problem.details["consent"].clone());
        }
    }
    result
}

fn approve_write(command: &str, org: &str, principal: &DeviceContext, args: &Value) -> Result<(), Problem> {
    if !is_write(command) || crate::jwt::is_service_scope(Some(&principal.scope)) { return Ok(()); }
    if crate::admin_lease::validate(&principal.device_id, command, args.get("adminLease").and_then(Value::as_str)).is_ok() { return Ok(()); }
    // Approval belongs to this device, org and operation. Neither confirmed:true
    // nor an approval for another org/operation can authorize the retry.
    let operations = vec![format!("org:{org}:{command}")];
    if crate::host_consent::take_approved(&principal.device_id, &operations) { return Ok(()); }
    let ask = crate::host_consent::request(&principal.device_id, Some(&principal.tenant_id), operations);
    Err(Problem::with_status(StatusCode::PRECONDITION_REQUIRED, "interactive_approval_required", "Host approval is required for this organization change")
        .with_detail_field("consent", serde_json::to_value(ask).unwrap_or(Value::Null)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Args {
    org_id: Option<String>,
    provider: Option<String>,
    api_key: Option<String>,
    allowed_agents: Option<Vec<String>>,
    default_agent: Option<String>,
    admin_lease: Option<String>,
}

pub async fn dispatch(command: &str, args: Value, device: &str, tenant: Option<&str>, scope: Option<&str>) -> Result<Value, (StatusCode, Json<RpcError>)> {
    dispatch_in_mode(deployment_mode(), command, args, device, tenant, scope).await
}

async fn dispatch_in_mode(mode: DeploymentMode, command: &str, args: Value, device: &str, tenant: Option<&str>, scope: Option<&str>) -> Result<Value, (StatusCode, Json<RpcError>)> {
    let principal = DeviceContext { device_id: device.into(), tenant_id: tenant.unwrap_or_default().into(), scope: scope.unwrap_or_default().into(), granted_scopes: vec![], authorization_capabilities: None };
    let (org, user) = caller_in_mode(mode, &args, &principal).await.map_err(|problem|
        (problem.status_code(), Json(RpcError::new(problem.code, problem.detail))))?;
    let input: Args = serde_json::from_value(args).map_err(|_| RpcError::malformed("invalid organization command arguments".into()))?;
    // Scope has already been resolved from the verified binding. These fields
    // are accepted only for service scope / canonical approval, never trusted.
    let _ = (&input.org_id, &input.admin_lease);
    let operation = command.to_string();
    let action = operation.clone();
    let audit_org = org.clone();
    let audit_user = user.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<Value, String> {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as i64;
        let required_provider = || input.provider.as_deref().ok_or_else(|| "provider is required".to_string());
        match operation.as_str() {
            "org_model_credential_list" => serde_json::to_value(OrgCredentials::list(&org)?).map_err(|_| "cannot encode metadata".into()),
            "org_model_credential_set" => {
                let metadata = OrgCredentials::set(&org, required_provider()?, input.api_key.as_deref().ok_or("apiKey is required")?, &user, now)?;
                serde_json::to_value(metadata).map_err(|_| "cannot encode metadata".into())
            },
            "org_model_credential_delete" => { OrgCredentials::delete(&org, required_provider()?)?; Ok(Value::Null) },
            "org_agent_policy_get" => serde_json::to_value(crate::org_agent_policy::get(&org)?).map_err(|_| "cannot encode policy".into()),
            "org_agent_policy_set" => serde_json::to_value(crate::org_agent_policy::set(&org,
                input.allowed_agents.ok_or("allowedAgents is required")?, input.default_agent, &user, now)?).map_err(|_| "cannot encode policy".into()),
            _ => Err("unknown organization command".into()),
        }
    }).await.map_err(|_| RpcError::internal("organization command worker failed".into()))?;
    if is_write(command) {
        // Audit only Host-derived authority and the operation. Never payloads,
        // credential values, or deserialization/storage error text.
        crate::audit::record_async(&action, device, scope.unwrap_or_default(), if result.is_ok() { "allow" } else { "deny" },
            json!({ "orgId": audit_org, "userId": audit_user })).await;
    }
    result.map_err(|error| if error.contains("unavailable") {
        RpcError::service_unavailable("organization store unavailable".into())
    } else { RpcError::malformed("invalid organization command arguments".into()) })
}

/// Named operator aliases use the very same canonical approval, contract,
/// receipt and dispatch path as /internal/_rpc. Router requires service JWT.
pub async fn credentials_handler(Path(operation): Path<String>, Extension(principal): Extension<DeviceContext>, headers: HeaderMap, State(state): State<SharedState>, body: Result<Json<Value>, JsonRejection>) -> Response {
    let command = match operation.as_str() { "list" => "org_model_credential_list", "set" => "org_model_credential_set", "delete" => "org_model_credential_delete", _ => return StatusCode::NOT_FOUND.into_response() };
    crate::api::internal_rpc_handler(Path(command.into()), Extension(principal), headers, State(state), body).await
}
pub async fn agents_handler(Path(operation): Path<String>, Extension(principal): Extension<DeviceContext>, headers: HeaderMap, State(state): State<SharedState>, body: Result<Json<Value>, JsonRejection>) -> Response {
    let command = match operation.as_str() { "get" => "org_agent_policy_get", "set" => "org_agent_policy_set", _ => return StatusCode::NOT_FOUND.into_response() };
    crate::api::internal_rpc_handler(Path(command.into()), Extension(principal), headers, State(state), body).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn p6a_mode_refuses_single_user_without_affecting_legacy_surfaces() {
        let refusal = require_mode(DeploymentMode::SingleUser).unwrap_err();
        assert_eq!(refusal.code, "org_scope_unavailable");
        assert_eq!(refusal.status_code(), StatusCode::CONFLICT);
        assert!(require_mode(DeploymentMode::MultiTenant).is_ok());
        assert!(!COMMANDS.contains(&"host_provider_credential_set"));
    }

    fn principal(scope: &str) -> DeviceContext {
        DeviceContext { device_id: "p6a-admin-device".into(), tenant_id: "p6a-tenant".into(), scope: scope.into(), granted_scopes: vec![], authorization_capabilities: None }
    }

    #[tokio::test]
    async fn p6a_caller_org_is_service_explicit_or_verified_never_device_selected() {
        let mode = DeploymentMode::MultiTenant;
        let service = principal("service");
        assert_eq!(caller_in_mode(mode, &json!({"orgId":"org_p6a_caller"}), &service).await.unwrap(), ("org_p6a_caller".into(), "operator".into()));
        assert_eq!(caller_in_mode(mode, &json!({}), &service).await.unwrap_err().code, "malformed_request");
        assert!(caller_in_mode(mode, &json!({"orgId":"../bad"}), &service).await.is_err());
        for scope in ["device", "owner", "person-brain"] {
            assert_eq!(caller_in_mode(mode, &json!({"orgId":"org_p6a_other"}), &principal(scope)).await.unwrap_err().code, "host_surface_forbidden");
        }
        for command in COMMANDS {
            let (status, error) = dispatch_in_mode(DeploymentMode::SingleUser, command, json!({}), "device", None, Some("service")).await.unwrap_err();
            assert_eq!(status, StatusCode::CONFLICT);
            assert_eq!(error.0.code, "org_scope_unavailable");
        }
    }

    #[test]
    fn p6a_org_writes_require_host_approval_bound_to_device_org_and_operation() {
        let p = principal("device");
        let command = "org_model_credential_set";
        let args = json!({"confirmed":true,"apiKey":"never-in-consent-or-errors"});
        let error = approve_write(command, "org_p6a_approval", &p, &args).unwrap_err();
        assert_eq!(error.status_code(), StatusCode::PRECONDITION_REQUIRED);
        assert!(!serde_json::to_string(&error).unwrap().contains("never-in-consent-or-errors"));
        let id = error.details["consent"]["id"].as_str().unwrap();
        assert!(crate::host_consent::resolve(id, true, crate::host_consent::Approver::Device(&p.device_id)).is_err());
        crate::host_consent::resolve(id, true, crate::host_consent::Approver::Host).unwrap();
        assert!(approve_write(command, "org_p6a_other", &p, &args).is_err());
        assert!(approve_write("org_model_credential_delete", "org_p6a_approval", &p, &args).is_err());
        let mut other_device = principal("person-brain");
        other_device.device_id = "p6a-other-device".into();
        assert!(approve_write(command, "org_p6a_approval", &other_device, &args).is_err());
        assert!(approve_write(command, "org_p6a_approval", &p, &args).is_ok());
        // Approval is consumed once only; person-brain never gets the service exemption.
        assert!(approve_write(command, "org_p6a_approval", &p, &args).is_err());
        assert!(approve_write(command, "org_p6a_approval", &principal("service"), &args).is_ok());
        crate::host_consent::forget_device(&p.device_id);
    }

    #[tokio::test]
    async fn p6a_service_commands_audit_every_mutation_without_disclosing_values() {
        let _guard = crate::audit::test_guard();
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("audit.log");
        crate::audit::install_at_for_testing(Some(path.clone()));
        let org = "org_p6a_audit";
        let key = "p6a-api-key-never-on-any-output";
        for (command, args) in [
            ("org_model_credential_set", json!({"orgId":org,"provider":"openai","apiKey":key})),
            ("org_model_credential_list", json!({"orgId":org})),
            ("org_agent_policy_set", json!({"orgId":org,"allowedAgents":["codex-acp"],"defaultAgent":"codex-acp"})),
            ("org_agent_policy_get", json!({"orgId":org})),
            ("org_model_credential_delete", json!({"orgId":org,"provider":"openai"})),
        ] {
            let output = dispatch_in_mode(DeploymentMode::MultiTenant, command, args, "operator", Some("tenant"), Some("service")).await.unwrap();
            assert!(!output.to_string().contains(key));
        }
        let (_, error) = dispatch_in_mode(DeploymentMode::MultiTenant, "org_model_credential_set", json!({"orgId":org,"provider":"openai","apiKey":key,"baseUrl":key}), "operator", Some("tenant"), Some("service")).await.unwrap_err();
        assert!(!serde_json::to_string(&error.0).unwrap().contains(key));
        let audit = std::fs::read_to_string(path).unwrap();
        assert!(!audit.contains(key));
        for command in ["org_model_credential_set", "org_model_credential_delete", "org_agent_policy_set"] { assert!(audit.contains(command)); }
        assert!(audit.contains(org));
        assert!(audit.contains("operator"));
        crate::audit::install_at_for_testing(None);
    }
}
