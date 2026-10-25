//! Tenant org administration shared by both command planes. This is a separate
//! module so no secret values or tenant scope enter the operator secret arms.
use axum::{extract::{Path, State, rejection::JsonRejection}, http::{HeaderMap, StatusCode}, response::{IntoResponse, Response}, Extension, Json};
use cognia_problem::Problem;
use serde::Deserialize;
use serde_json::{json, Value};
use crate::{deployment::{deployment_mode, DeploymentMode}, middleware::DeviceContext, org_credentials::OrgCredentials, rpc_error::RpcError, SharedState};

// The server installs the very same registry used by its gateway. No second
// ledger, no server dependency, and desktop never installs a member ledger.
static ORG_USAGE_REGISTRY: parking_lot::RwLock<Option<std::sync::Arc<cognia_gateway::route_ticket::RouteTicketRegistry>>> = parking_lot::RwLock::new(None);
pub fn org_usage_install(registry: std::sync::Arc<cognia_gateway::route_ticket::RouteTicketRegistry>) {
    *ORG_USAGE_REGISTRY.write() = Some(registry);
}

// P6c serialize key read + mint against credential mutation + revocation.
// Held only in synchronous blocking workers, never across await.
pub static PERSON_CREDENTIAL_FENCE: parking_lot::Mutex<()> = parking_lot::Mutex::new(());
pub fn person_revoke_provider(org: &str, provider: &str) {
    if let Some(registry) = ORG_USAGE_REGISTRY.read().clone() { registry.person_revoke_provider(org, provider); }
}

/// One member's own spend and cap for the current month (P6g), for that
/// member's person brain only. `None` when no usage ledger is installed or it
/// cannot be read; never another person's row.
pub fn person_own_usage(org: &str, user: &str) -> Option<Value> {
    let registry = ORG_USAGE_REGISTRY.read().clone()?;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as i64;
    let month = cognia_gateway::org_usage::month_at(now);
    let report = registry.org_member_usage_get(org, &month, &[user.to_string()]).ok()?;
    let row = report["members"].as_array()?.iter().find(|row| row["userId"] == user)?;
    Some(json!({"month": month, "spentTokens": row["spentTokens"], "reservedTokens": row["reservedTokens"],
        "monthlyTokens": row["monthlyTokens"]}))
}

pub const CAPABILITY: &str = "org.policy.manage";
pub const COMMANDS: &[&str] = &["org_model_credential_list", "org_model_credential_set", "org_model_credential_delete", "org_agent_policy_get", "org_agent_policy_set", "org_member_usage_get", "org_usage_cap_set", "org_member_usage_cap_set"];
tokio::task_local! { static AUTHORITY: Option<(String, String)>; }
pub fn current_authority() -> Option<(String, String)> { AUTHORITY.try_with(Clone::clone).ok().flatten() }
pub async fn scope<T>(authority: Option<(String, String)>, future: impl std::future::Future<Output = T>) -> T {
    AUTHORITY.scope(authority, future).await
}
pub fn is_write(command: &str) -> bool {
    matches!(command, "org_model_credential_set" | "org_model_credential_delete" | "org_agent_policy_set" | "org_usage_cap_set" | "org_member_usage_cap_set")
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

/// Signed device requests need only their verified org binding and live
/// org.policy.manage standing. No Host consent or admin lease is involved.
pub async fn authorize_request(_state: &SharedState, request: &crate::remote_execution::ExecutionRequest) -> Result<(), Problem> {
    caller(&request.args, &request.principal).await.map(|_| ())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Args {
    org_id: Option<String>,
    provider: Option<String>,
    api_key: Option<String>,
    allowed_agents: Option<Vec<String>>,
    default_agent: Option<String>,
}

pub async fn dispatch(command: &str, args: Value, device: &str, tenant: Option<&str>, scope: Option<&str>) -> Result<Value, (StatusCode, Json<RpcError>)> {
    dispatch_in_mode(deployment_mode(), command, args, device, tenant, scope).await
}

async fn dispatch_in_mode(mode: DeploymentMode, command: &str, args: Value, device: &str, tenant: Option<&str>, scope: Option<&str>) -> Result<Value, (StatusCode, Json<RpcError>)> {
    let principal = DeviceContext { device_id: device.into(), tenant_id: tenant.unwrap_or_default().into(), scope: scope.unwrap_or_default().into(), granted_scopes: vec![], authorization_capabilities: None };
    let (org, user) = caller_in_mode(mode, &args, &principal).await.map_err(|problem|
        (problem.status_code(), Json(RpcError::new(problem.code, problem.detail))))?;
    if matches!(command, "org_member_usage_get" | "org_usage_cap_set" | "org_member_usage_cap_set") {
        return org_usage_dispatch(command, args, &org, &user, device, scope).await;
    }
    let input: Args = serde_json::from_value(args).map_err(|_| RpcError::malformed("invalid organization command arguments".into()))?;
    // Scope has already been resolved from the verified caller.
    let _ = &input.org_id;
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
                let _p6c_fence = PERSON_CREDENTIAL_FENCE.lock();
                let metadata = OrgCredentials::set(&org, required_provider()?, input.api_key.as_deref().ok_or("apiKey is required")?, &user, now);
                person_revoke_provider(&org, required_provider()?);
                let metadata = metadata?;
                serde_json::to_value(metadata).map_err(|_| "cannot encode metadata".into())
            },
            "org_model_credential_delete" => {
                let _p6c_fence = PERSON_CREDENTIAL_FENCE.lock();
                let deleted = OrgCredentials::delete(&org, required_provider()?);
                person_revoke_provider(&org, required_provider()?);
                deleted?;
                Ok(Value::Null)
            },
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

/// Values are parsed explicitly to distinguish missing, null (unlimited),
/// and "default" (delete override). Never echo rejected inputs in errors.
fn org_usage_tokens(value: Option<&Value>, allow_default: bool) -> Result<Option<Option<u64>>, String> {
    match value {
        Some(Value::Null) => Ok(Some(None)),
        Some(Value::String(value)) if allow_default && value == "default" => Ok(None),
        Some(value) => value.as_u64().filter(|n| *n <= cognia_gateway::org_usage::MAX_MONTHLY_TOKENS)
            .map(|n| Some(Some(n))).ok_or_else(|| "invalid monthly tokens".into()),
        None => Err("monthly tokens are required".into()),
    }
}

fn org_usage_apply(registry: &cognia_gateway::route_ticket::RouteTicketRegistry, command: &str, args: &Value, org: &str, people: &[String]) -> Result<Value, String> {
    let allowed: &[&str] = match command {
        "org_member_usage_get" => &["orgId", "month"],
        "org_usage_cap_set" => &["orgId", "defaultMonthlyTokens"],
        "org_member_usage_cap_set" => &["orgId", "userId", "monthlyTokens"],
        _ => return Err("unknown organization usage command".into()),
    };
    let object = args.as_object().ok_or("invalid organization command arguments")?;
    if object.keys().any(|key| !allowed.contains(&key.as_str())) { return Err("invalid organization command arguments".into()); }
    match command {
        "org_member_usage_get" => {
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as i64;
            let current = cognia_gateway::org_usage::month_at(now);
            let month = match args.get("month") { None => current.as_str(), Some(Value::String(month)) => month, _ => return Err("invalid month".into()) };
            registry.org_member_usage_get(org, month, people)
        },
        "org_usage_cap_set" => {
            registry.org_usage_cap_set(org, None, org_usage_tokens(args.get("defaultMonthlyTokens"), false)?)?;
            Ok(Value::Null)
        },
        "org_member_usage_cap_set" => {
            let user = args.get("userId").and_then(Value::as_str).ok_or("userId is required")?;
            cognia_tenant_auth::UserId::parse(user).map_err(|_| "invalid user id")?;
            registry.org_usage_cap_set(org, Some(user), org_usage_tokens(args.get("monthlyTokens"), true)?)?;
            Ok(Value::Null)
        },
        _ => unreachable!(),
    }
}

async fn org_usage_dispatch(command: &str, args: Value, org: &str, user: &str, device: &str, scope: Option<&str>) -> Result<Value, (StatusCode, Json<RpcError>)> {
    let registry = ORG_USAGE_REGISTRY.read().clone();
    let people = crate::person_partition::fleet().map(|fleet| fleet.org_people(org)).unwrap_or_default();
    // Audit only validated ids/numbers; no arbitrary client values or strings.
    let mut audit = json!({ "orgId": org, "userId": user });
    if let Some(member) = args.get("userId").and_then(Value::as_str).filter(|id| cognia_tenant_auth::UserId::parse(*id).is_ok()) {
        audit["memberUserId"] = member.into();
    }
    for key in ["defaultMonthlyTokens", "monthlyTokens"] {
        if let Some(tokens) = args.get(key).and_then(Value::as_u64).filter(|n| *n <= cognia_gateway::org_usage::MAX_MONTHLY_TOKENS) { audit[key] = tokens.into(); }
    }
    let operation = command.to_string(); let usage_org = org.to_string();
    let result = tokio::task::spawn_blocking(move || {
        let registry = registry.ok_or("organization usage store unavailable")?;
        org_usage_apply(&registry, &operation, &args, &usage_org, &people)
    }).await
        .map_err(|_| RpcError::internal("organization usage worker failed".into()))?;
    if is_write(command) {
        crate::audit::record_async(command, device, scope.unwrap_or_default(), if result.is_ok() { "allow" } else { "deny" }, audit).await;
    }
    let mut report = result.map_err(|error| if error.contains("unavailable") { RpcError::service_unavailable("organization usage store unavailable".into()) }
        else { RpcError::malformed("invalid organization command arguments".into()) })?;
    if command == "org_member_usage_get" {
        label_members(&mut report, |ids| async move { crate::workspace_access::org_member_names(org, &ids).await }).await;
    }
    Ok(report)
}

/// Name each member of a usage report as the collaboration plane knows them.
///
/// A label, not part of the answer's truth: when the plane cannot be asked
/// (unconfigured, down, refusing this Host) the report goes out with ids
/// alone, as it did before, and the panel falls back to the id.
async fn label_members<F, Fut>(report: &mut Value, names: F)
where
    F: FnOnce(Vec<String>) -> Fut,
    Fut: std::future::Future<Output = Result<std::collections::BTreeMap<String, String>, crate::workspace_access::WorkspaceAccessError>>,
{
    let Some(members) = report.get_mut("members").and_then(Value::as_array_mut) else { return };
    let ids: Vec<String> = members.iter().filter_map(|row| row["userId"].as_str().map(str::to_string)).collect();
    if ids.is_empty() { return; }
    let names = match names(ids).await {
        Ok(names) => names,
        Err(error) => {
            tracing::warn!(code = error.code(), "organization member names unavailable: {error}");
            return;
        }
    };
    for row in members.iter_mut() {
        let name = row["userId"].as_str().and_then(|id| names.get(id)).map(|name| name.trim()).filter(|name| !name.is_empty());
        if let (Some(name), Some(object)) = (name, row.as_object_mut()) {
            object.insert("displayName".into(), name.chars().take(200).collect::<String>().into());
        }
    }
}

pub async fn org_usage_handler(Path(operation): Path<String>, Extension(principal): Extension<DeviceContext>, headers: HeaderMap, State(state): State<SharedState>, body: Result<Json<Value>, JsonRejection>) -> Response {
    let command = match operation.as_str() { "get" => "org_member_usage_get", "set-default" => "org_usage_cap_set", "set-member" => "org_member_usage_cap_set", _ => return StatusCode::NOT_FOUND.into_response() };
    crate::api::internal_rpc_handler(Path(command.into()), Extension(principal), headers, State(state), body).await
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

    #[tokio::test]
    async fn p6_usage_report_members_carry_the_planes_names_or_stay_ids() {
        let report = || json!({"month": "2026-10", "defaultMonthlyTokens": null, "members": [
            {"userId": "usr_ada", "spentTokens": 1, "reservedTokens": 0, "monthlyTokens": null, "capSource": "default"},
            {"userId": "usr_bob", "spentTokens": 0, "reservedTokens": 0, "monthlyTokens": 5, "capSource": "override"},
            {"userId": "usr_cy", "spentTokens": 0, "reservedTokens": 0, "monthlyTokens": null, "capSource": "default"},
        ]});
        let mut named = report();
        label_members(&mut named, |ids| async move {
            assert_eq!(ids, ["usr_ada", "usr_bob", "usr_cy"]);
            // Bob's name is blank, Cy left the org: both stay ids.
            Ok(std::collections::BTreeMap::from([
                ("usr_ada".to_string(), "  Ada Lovelace ".to_string()),
                ("usr_bob".to_string(), "   ".to_string()),
            ]))
        }).await;
        assert_eq!(named["members"][0]["displayName"], "Ada Lovelace");
        assert!(named["members"][1].get("displayName").is_none());
        assert!(named["members"][2].get("displayName").is_none());
        assert_eq!(named["members"][0]["spentTokens"], 1);

        // The plane cannot be asked: the report goes out exactly as before.
        let mut unnamed = report();
        label_members(&mut unnamed, |_| async { Err(crate::workspace_access::WorkspaceAccessError::NotConfigured) }).await;
        assert_eq!(unnamed, report());

        // No members: nobody is asked.
        let mut empty = json!({"month": "2026-10", "defaultMonthlyTokens": null, "members": []});
        label_members(&mut empty, |_| async { panic!("asked for no one") }).await;
    }
    #[test]
    fn p6g_person_own_usage_reports_only_the_callers_month_and_cap() {
        use cognia_gateway::route_ticket::{RouteTicketRegistry, InMemoryTicketMetaStore};
        // The same guard the registry-swapping tests below hold.
        let _audit = crate::audit::test_guard();
        let previous = ORG_USAGE_REGISTRY.read().clone();
        struct Restore(Option<std::sync::Arc<RouteTicketRegistry>>);
        impl Drop for Restore { fn drop(&mut self) { *ORG_USAGE_REGISTRY.write() = self.0.take(); } }
        let _restore = Restore(previous);
        *ORG_USAGE_REGISTRY.write() = None;
        assert_eq!(person_own_usage("org_p6g_usage", "usr_p6g_a"), None);
        let registry = std::sync::Arc::new(RouteTicketRegistry::new(std::sync::Arc::new(InMemoryTicketMetaStore::default())));
        org_usage_install(registry.clone());
        registry.org_usage_cap_set("org_p6g_usage", None, Some(Some(100))).unwrap();
        registry.org_usage_cap_set("org_p6g_usage", Some("usr_p6g_b"), Some(Some(7))).unwrap();
        let own = person_own_usage("org_p6g_usage", "usr_p6g_a").unwrap();
        let month = cognia_gateway::org_usage::month_at(chrono::Utc::now().timestamp_millis());
        assert_eq!(own, json!({"month":month,"spentTokens":0,"reservedTokens":0,"monthlyTokens":100}));
        assert_eq!(person_own_usage("org_p6g_usage", "usr_p6g_b").unwrap()["monthlyTokens"], 7);
        registry.org_usage_cap_set("org_p6g_usage", Some("usr_p6g_b"), Some(None)).unwrap();
        assert_eq!(person_own_usage("org_p6g_usage", "usr_p6g_b").unwrap()["monthlyTokens"], Value::Null);
        // Nothing about anyone else rides along.
        assert!(!own.to_string().contains("usr_p6g_b"));
    }
    #[tokio::test]
    async fn p6d_credential_mutation_revokes_member_task_leases_under_the_same_fence() {
        let _audit = crate::audit::test_guard();
        let gateway = cognia_gateway::GatewayState::new();
        let previous = ORG_USAGE_REGISTRY.read().clone();
        struct Restore(Option<std::sync::Arc<cognia_gateway::route_ticket::RouteTicketRegistry>>);
        impl Drop for Restore { fn drop(&mut self) { *ORG_USAGE_REGISTRY.write() = self.0.take(); } }
        let _restore = Restore(previous); org_usage_install(gateway.tickets.clone());
        let org = "org_p6d_rotation";
        let mint = || gateway.person_mint_task_lease("pb_p6d_rotation",cognia_gateway::route_ticket::MemberBinding { org_id:org.into(),user_id:"usr_p6d_rotation".into() },
            "pi","p6d-task",gateway.status().account_generation,serde_json::from_value(json!({"id":"p6d-provider","enabled":true,"protocol":"openai",
                "baseUrl":"https://fixture.invalid/v1","apiKey":"old-org-key","models":["model"]})).unwrap(),"model".into(),"openai-chat").unwrap();
        let first = mint();
        dispatch_in_mode(DeploymentMode::MultiTenant,"org_model_credential_set",json!({"orgId":org,"provider":"p6d-provider","apiKey":"new-key"}),"operator",None,Some("service")).await.unwrap();
        assert!(gateway.tickets.validate(&first.secret,chrono::Utc::now().timestamp_millis()).is_err());
        let second = mint();
        dispatch_in_mode(DeploymentMode::MultiTenant,"org_model_credential_delete",json!({"orgId":org,"provider":"p6d-provider"}),"operator",None,Some("service")).await.unwrap();
        assert!(gateway.tickets.validate(&second.secret,chrono::Utc::now().timestamp_millis()).is_err());
    }

    #[tokio::test]
    async fn p6c_credential_set_and_delete_revoke_only_matching_org_provider_tickets() {
        use cognia_gateway::route_ticket::{RouteTicketRegistry, InMemoryTicketMetaStore, MintRequest, MemberBinding};
        let _audit = crate::audit::test_guard();
        let registry = std::sync::Arc::new(RouteTicketRegistry::new(std::sync::Arc::new(InMemoryTicketMetaStore::default())));
        let previous = ORG_USAGE_REGISTRY.read().clone();
        struct Restore(Option<std::sync::Arc<RouteTicketRegistry>>);
        impl Drop for Restore { fn drop(&mut self) { *ORG_USAGE_REGISTRY.write() = self.0.take(); } }
        let _restore = Restore(previous);
        org_usage_install(registry.clone());
        let org = "org_p6c_rotation";
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
        let snapshot = serde_json::from_value(json!({"generatedAtMs":now,"providers":[
            {"id":"p6c-provider","enabled":true,"protocol":"openai","baseUrl":"https://fixture.invalid/v1","models":["model"]},
            {"id":"p6c-other","enabled":true,"protocol":"openai","baseUrl":"https://other.invalid/v1","models":["model"]}
        ]})).unwrap();
        let mint = |org: &str, provider: &str| {
            let mut provider_snapshot: cognia_gateway::snapshot::ProviderSnapshot = serde_json::from_value(json!({
                "id":provider,"enabled":true,"protocol":"openai","baseUrl":"https://fixture.invalid/v1","models":["model"],"apiKey":"old-org-key"})).unwrap();
            provider_snapshot.deployment_id = Some(provider.into());
            let request: MintRequest = serde_json::from_value(json!({"sessionId":"p6c-revoke","executionFingerprint":uuid::Uuid::new_v4().to_string(),
                "candidates":[{"deploymentId":provider,"modelId":"model"}],"credentialAffinity":"session-sticky","routePolicy":"p6c"})).unwrap();
            let mut request = request; request.provider_overrides = vec![provider_snapshot];
            registry.person_mint_owned(request, Some(&snapshot), now, Some("pb_p6c".into()), Some(MemberBinding { org_id:org.into(), user_id:"usr_p6c_rotation".into() })).unwrap()
        };
        let first = mint(org, "p6c-provider");
        let other_provider = mint(org, "p6c-other"); let other_org = mint("org_p6c_other", "p6c-provider");
        dispatch_in_mode(DeploymentMode::MultiTenant, "org_model_credential_set", json!({"orgId":org,"provider":"p6c-provider","apiKey":"new-org-key"}),
            "operator", None, Some("service")).await.unwrap();
        assert!(registry.validate(&first.secret, now).is_err());
        assert!(registry.provider_overrides(&first.ticket.ticket_id).is_empty());
        assert!(registry.validate(&other_provider.secret, now).is_ok()); assert!(registry.validate(&other_org.secret, now).is_ok());
        let second = mint(org, "p6c-provider");
        dispatch_in_mode(DeploymentMode::MultiTenant, "org_model_credential_delete", json!({"orgId":org,"provider":"p6c-provider"}),
            "operator", None, Some("service")).await.unwrap();
        assert!(registry.validate(&second.secret, now).is_err());
        assert!(registry.validate(&other_provider.secret, now).is_ok()); assert!(registry.validate(&other_org.secret, now).is_ok());
    }

    #[tokio::test]
    async fn p6b_org_usage_admin_validation_approval_audit_and_mode() {
        use cognia_gateway::route_ticket::{RouteTicketRegistry, InMemoryTicketMetaStore};
        // Guard first: the other tests swap the process-wide usage registry under it.
        let _guard = crate::audit::test_guard();
        let registry = std::sync::Arc::new(RouteTicketRegistry::new(std::sync::Arc::new(InMemoryTicketMetaStore::default())));
        org_usage_install(registry.clone());
        let org = "org_p6b_admin";
        let user = "usr_p6b_member";
        let temp = tempfile::tempdir().unwrap(); let path = temp.path().join("audit.log");
        crate::audit::install_at_for_testing(Some(path.clone()));
        for (command, args) in [
            ("org_usage_cap_set", json!({"orgId":org,"defaultMonthlyTokens":100})),
            ("org_member_usage_cap_set", json!({"orgId":org,"userId":user,"monthlyTokens":20})),
            ("org_member_usage_get", json!({"orgId":org,"month":"2026-10"})),
        ] {
            assert!(COMMANDS.contains(&command));
            let result = dispatch_in_mode(DeploymentMode::MultiTenant, command, args.clone(), "operator", None, Some("service")).await.unwrap();
            if command == "org_member_usage_get" {
                assert_eq!(result["members"][0]["monthlyTokens"], 20);
                assert_eq!(result["members"][0]["capSource"], "override");
            }
            let (status, error) = dispatch_in_mode(DeploymentMode::SingleUser, command, args, "operator", None, Some("service")).await.unwrap_err();
            assert_eq!(status, StatusCode::CONFLICT); assert_eq!(error.0.code, "org_scope_unavailable");
        }
        for invalid in [json!({}), json!({"defaultMonthlyTokens":-1}), json!({"defaultMonthlyTokens":1.5}), json!({"defaultMonthlyTokens":1000000000001u64}), json!({"defaultMonthlyTokens":"default"})] {
            assert!(org_usage_apply(&registry, "org_usage_cap_set", &invalid, org, &[]).is_err());
        }
        for invalid in [json!({"userId":"../bad","monthlyTokens":1}), json!({"userId":user}), json!({"userId":user,"monthlyTokens":true}), json!({"userId":user,"monthlyTokens":1,"payload":"p6b-never-audited"})] {
            let mut args = invalid; args["orgId"] = org.into();
            assert!(dispatch_in_mode(DeploymentMode::MultiTenant, "org_member_usage_cap_set", args, "operator", None, Some("service")).await.is_err());
        }
        assert!(org_usage_apply(&registry, "org_member_usage_get", &json!({"month":"2026-13"}), org, &[]).is_err());
        assert!(org_usage_apply(&registry, "org_member_usage_get", &json!({"month":null}), org, &[]).is_err());
        org_usage_apply(&registry, "org_member_usage_cap_set", &json!({"userId":user,"monthlyTokens":null}), org, &[]).unwrap();
        assert_eq!(registry.org_member_usage_get(org, "2026-10", &[]).unwrap()["members"][0]["monthlyTokens"], Value::Null);
        org_usage_apply(&registry, "org_member_usage_cap_set", &json!({"userId":user,"monthlyTokens":"default"}), org, &[]).unwrap();
        let result = registry.org_member_usage_get(org, "2026-10", &[user.into()]).unwrap();
        assert_eq!(result["members"][0]["monthlyTokens"], 100);
        assert_eq!(result["members"][0]["capSource"], "default");
        assert!(registry.org_member_usage_get("org_p6b_other", "2026-10", &[]).unwrap()["members"].as_array().unwrap().is_empty());
        let audit = std::fs::read_to_string(path).unwrap();
        assert!(audit.contains("org_usage_cap_set")); assert!(audit.contains("org_member_usage_cap_set"));
        assert!(audit.contains(org)); assert!(audit.contains(user)); assert!(!audit.contains("p6b-never-audited"));
        crate::audit::install_at_for_testing(None);
    }

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
    fn p6b_org_writes_require_no_consent_or_lease_contract() {
        for command in COMMANDS.iter().filter(|command| is_write(command)) {
            let descriptor = crate::command_manifest::descriptor(command).unwrap();
            assert_eq!(descriptor.approval, crate::command_manifest::CommandApproval::None);
            let input = json!({"adminLease":"obsolete"});
            if command.starts_with("org_model_") || command.starts_with("org_agent_") {
                assert!(serde_json::from_value::<Args>(input).is_err());
            }
        }
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
