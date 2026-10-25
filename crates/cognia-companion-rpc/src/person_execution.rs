//! P6d partition execution. Extends P6c brokerage without operator authority.
use axum::{http::StatusCode, Json};
use cognia_companion::{person_partition::PersonPartition, rpc_error::RpcError, SharedState};
use cognia_external_agent::{process::ExternalAgentSpawnConfig, spawn_authority::{CredentialDelivery, GatewayAuthority}};
use cognia_gateway::{GatewayState, route_ticket::MemberBinding};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

type PersonResult<T> = Result<T, (StatusCode, Json<RpcError>)>;
pub(crate) fn person_refusal(status: StatusCode, code: &str) -> (StatusCode, Json<RpcError>) {
    (status, Json(RpcError::new(code, code)))
}
pub(crate) fn person_caller(scope: Option<&str>, tenant: Option<&str>, command: &str) -> PersonResult<PersonPartition> {
    let principal = cognia_companion::middleware::DeviceContext { device_id: String::new(), tenant_id: tenant.unwrap_or_default().into(),
        scope: scope.unwrap_or_default().into(), granted_scopes: vec![], authorization_capabilities: None };
    let person = cognia_companion::person_chat::person_caller(&principal, command)
        .map_err(|_| crate::person_model::person_forbidden())?;
    if cognia_companion::person_partition::current().as_ref() != Some(&person) { return Err(crate::person_model::person_forbidden()); }
    Ok(person)
}
fn person_member(person: &PersonPartition) -> MemberBinding {
    MemberBinding { org_id: person.org_id.clone(), user_id: person.user_id.clone() }
}
pub(crate) fn person_runtime_admit(person: &PersonPartition, runtime: &str, provider: Option<&str>) -> PersonResult<()> {
    let policy = cognia_companion::org_agent_policy::get(&person.org_id)
        .map_err(|_| person_refusal(StatusCode::SERVICE_UNAVAILABLE, "model_access_unavailable"))?;
    let entry = policy.allowed_agents.iter().find(|entry| entry.runtime_id == runtime)
        .ok_or_else(|| person_refusal(StatusCode::FORBIDDEN, "org_agent_not_allowed"))?;
    if !entry.available || provider.is_some_and(|provider| !entry.providers.iter().any(|id| id == provider)) {
        return Err(person_refusal(StatusCode::SERVICE_UNAVAILABLE, "model_access_unavailable"));
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PersonAgentLeaseRequest {
    pub runtime_id: String, pub provider: String, pub model: String, pub session_id: Option<String>,
}
pub(crate) fn person_lease_mint(person: &PersonPartition, request: PersonAgentLeaseRequest, gateway: &GatewayState) -> PersonResult<Value> {
    let _p6d_fence = cognia_companion::org_policy::PERSON_CREDENTIAL_FENCE.lock();
    person_runtime_admit(person, &request.runtime_id, Some(&request.provider))?;
    let family = cognia_companion::org_agent_policy::person_runtime_family(&request.runtime_id)
        .ok_or_else(|| person_refusal(StatusCode::SERVICE_UNAVAILABLE, "model_access_unavailable"))?;
    let unavailable = || person_refusal(StatusCode::SERVICE_UNAVAILABLE, "model_access_unavailable");
    let key = cognia_companion::org_credentials::OrgCredentials::org_provider_key(&person.org_id, &request.provider)
        .map_err(|_| unavailable())?.ok_or_else(unavailable)?;
    let mut provider = gateway.with_snapshot(|snapshot| snapshot.and_then(|snapshot| snapshot.provider(&request.provider)).cloned()).ok_or_else(unavailable)?;
    if !provider.models.contains(&request.model) { return Err(RpcError::malformed("invalid model".into())); }
    provider.api_key = Some(key); provider.api_keys.clear(); provider.rotation_enabled = false; provider.rotation_strategy = None;
    let task = request.session_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let lease = gateway.person_mint_task_lease(&person.account_id, person_member(person), &request.runtime_id, &task,
        gateway.status().account_generation, provider, request.model, if family == "codex" { "openai-responses" } else { "openai-chat" })
        .map_err(|_| unavailable())?;
    serde_json::to_value(lease).map_err(|_| unavailable())
}
pub(crate) async fn person_agent_lease_prepare(args: Value, scope: Option<&str>, tenant: Option<&str>, state: &SharedState,
    host: &dyn crate::rpc_host::RpcHost) -> PersonResult<Value> {
    if scope != Some("person-brain") { return Err(crate::person_model::person_forbidden()); }
    cognia_companion::org_policy::require_mode(cognia_companion::deployment::deployment_mode())
        .map_err(|p| (p.status_code(), Json(RpcError::new(p.code, p.detail))))?;
    let person = person_caller(scope, tenant, "person_agent_lease_prepare")?;
    let _person_lock = cognia_companion::host_surface_gate::person_execution_lock(&person.account_id).lock_owned().await;
    // Recheck the fleet after waiting on purge's partition fence.
    let person = person_caller(scope, tenant, "person_agent_lease_prepare")?;
    cognia_companion::host_surface_gate::person_execution_standing(&person).await
        .map_err(|p| (p.status_code(), Json(RpcError::new(p.code, p.detail))))?;
    let request: PersonAgentLeaseRequest = serde_json::from_value(args).map_err(|_| RpcError::malformed("invalid person task request".into()))?;
    if request.runtime_id.is_empty() || request.provider.is_empty() || request.model.is_empty()
        || request.session_id.as_ref().is_some_and(|id| id.is_empty() || id.len() > 128 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')) {
        return Err(RpcError::malformed("invalid person task request".into()));
    }
    let shared = host.to_shared(); let minted_for = person.clone();
    let mut result = tokio::task::spawn_blocking(move || {
        let gateway = shared.gateway().ok_or_else(|| person_refusal(StatusCode::SERVICE_UNAVAILABLE, "model_access_unavailable"))?;
        person_lease_mint(&minted_for, request, gateway)
    }).await.map_err(|_| person_refusal(StatusCode::SERVICE_UNAVAILABLE, "model_access_unavailable"))??;
    let ticket = result["ticketId"].as_str().unwrap_or_default();
    let generation = result["accountGeneration"].as_u64().unwrap_or_default();
    let port = crate::person_model::person_ensure_listener(state, host, ticket, generation).await?;
    result["endpoint"] = json!(format!("http://127.0.0.1:{port}/v1"));
    cognia_companion::audit::record_async("person_agent_lease_prepare", &format!("brain-{}", person.account_id), "person-brain", "allow",
        json!({"accountId":person.account_id,"ticketId":result["ticketId"]})).await;
    Ok(result)
}

fn person_workspace_error(error: cognia_external_agent::person_workspace::PersonWorkspaceError) -> (StatusCode, Json<RpcError>) {
    use cognia_external_agent::person_workspace::PersonWorkspaceError::*;
    let mut body = RpcError::new(error.code(), error.code());
    let status = match error {
        Mount => StatusCode::FORBIDDEN, Unavailable => StatusCode::SERVICE_UNAVAILABLE,
        Quota { used_bytes, max_bytes } => { body.details = Some(json!({"usedBytes":used_bytes,"maxBytes":max_bytes})); StatusCode::INSUFFICIENT_STORAGE }
    };
    (status, Json(body))
}
pub(crate) async fn person_prepare_spawn(person: &PersonPartition, runtime: &str, policy: cognia_external_agent::presets::SpawnPolicy,
    config: &mut ExternalAgentSpawnConfig, host: &dyn crate::rpc_host::RpcHost) -> PersonResult<(std::path::PathBuf, GatewayAuthority)> {
    if !cognia_companion::host_surface_gate::person_execution_available().await {
        return Err(person_refusal(StatusCode::SERVICE_UNAVAILABLE, "execution_isolation_unavailable"));
    }
    // Fresh standing was checked when constructing the typed admission;
    // never resolve a device or accept another authority from spawn args.
    let decision = cognia_external_agent::spawn_authority::execution_admission().ok_or_else(crate::person_model::person_forbidden)?;
    if cognia_companion::host_surface_gate::person_execution_owner(&decision.binding).as_ref() != Some(person) {
        return Err(crate::person_model::person_forbidden());
    }
    person_runtime_admit(person, runtime, None)?;
    if !cognia_companion::org_agent_policy::person_runtime_matches(runtime, &config.command, &config.args) {
        return Err(person_refusal(StatusCode::FORBIDDEN, "org_agent_not_allowed"));
    }
    if CredentialDelivery::for_inputs(config.env.keys().map(String::as_str), config.args.iter().map(String::as_str), false) != CredentialDelivery::Brokered {
        return Err(person_refusal(StatusCode::FORBIDDEN, "credential_delivery_refused"));
    }
    if config.env.keys().any(|key| !["COGNIA_GATEWAY_TOKEN", "COGNIA_GATEWAY_TASK_CONFIG", "TERM", "LANG", "LC_ALL", "LC_CTYPE"].contains(&key.as_str())) {
        return Err(person_refusal(StatusCode::FORBIDDEN, "credential_delivery_refused"));
    }
    let placement = config.sandbox.as_ref().ok_or_else(|| person_refusal(StatusCode::SERVICE_UNAVAILABLE, "execution_isolation_unavailable"))?;
    if placement.binding().is_some() { return Err(person_refusal(StatusCode::FORBIDDEN, "placement_binding_client_supplied")); }
    if placement.provider() != "local" || placement.workspace().is_some() || !placement.hosted_tool_host_lease_ids().is_empty() {
        return Err(person_refusal(StatusCode::SERVICE_UNAVAILABLE, "execution_isolation_unavailable"));
    }
    // Validate the partition lease before creating its first workspace.
    let gateway = person_authorize_task_spawn(host, person, runtime, config)?;
    let account = person.account_id.clone(); let cwd = config.cwd.clone();
    let (root, cwd) = tokio::task::spawn_blocking(move || {
        let max = cognia_external_agent::person_workspace::person_workspace_max_bytes().map_err(|_| cognia_external_agent::person_workspace::PersonWorkspaceError::Unavailable)?;
        cognia_external_agent::person_workspace::person_workspace_prepare(&policy, &account, cwd.as_deref(), max)
    }).await.map_err(|_| person_refusal(StatusCode::SERVICE_UNAVAILABLE, "person_workspace_unavailable"))?.map_err(person_workspace_error)?;
    config.cwd = Some(cwd.to_string_lossy().into_owned());
    Ok((root, gateway))
}

pub(crate) fn person_authorize_task_spawn(host: &dyn crate::rpc_host::RpcHost, person: &PersonPartition,
    runtime: &str, config: &mut ExternalAgentSpawnConfig) -> PersonResult<GatewayAuthority> {
    let refused = || person_refusal(StatusCode::FORBIDDEN, "credential_delivery_refused");
    let gateway = host.gateway().ok_or_else(refused)?.clone();
    let mut payload: Value = config.env.get("COGNIA_GATEWAY_TASK_CONFIG").and_then(|raw| serde_json::from_str(raw).ok()).ok_or_else(refused)?;
    let task = payload["taskId"].as_str().ok_or_else(refused)?.to_owned();
    let secret = config.env.get("COGNIA_GATEWAY_TOKEN").cloned().ok_or_else(refused)?;
    let family = cognia_companion::org_agent_policy::person_runtime_family(runtime).ok_or_else(refused)?;
    // Files/config catalogs can smuggle non-brokered credentials. P6e supplies
    // only the task launch envelope; broker configuration is written below.
    if payload["runtime"].as_str() != Some(family)
        || payload.get("files").is_some_and(|files| !files.as_object().is_some_and(|files| files.is_empty()))
        || payload.get("codexModelCatalog").is_some()
        || payload.as_object().is_none_or(|fields| fields.keys().any(|key| !["taskId","runtime","binding","ownerAccountId","originDeviceId","rebind","files"].contains(&key.as_str()))) {
        return Err(refused());
    }
    let member = person_member(person);
    gateway.person_validate_task_secret(&person.account_id, &member, runtime, &task, &secret).map_err(|_| refused())?;
    let status = gateway.status();
    let port = status.bound_port.filter(|_| status.running).ok_or_else(refused)?;
    cognia_gateway::task_lease::validate_task_endpoints(&config.env, &config.args, &payload, &format!("http://127.0.0.1:{port}/v1")).map_err(|_| refused())?;
    payload["ownerAccountId"] = json!(person.account_id);
    payload["originDeviceId"] = json!(format!("brain-{}", person.account_id));
    payload["rebind"] = json!(false);
    payload["files"] = json!({});
    let ticket = gateway.tickets.validate(&secret, chrono::Utc::now().timestamp_millis()).map_err(|_| refused())?;
    let model = &ticket.candidates[0].model_id;
    payload["binding"] = json!({"providerId":ticket.candidates[0].deployment_id,"modelId":model});
    person_broker_configuration(config, &mut payload, family, runtime, model, port, &secret);
    // These are gateway references, never credentials. sandboxd replaces the
    // endpoint on entering the container and derives the task-owned env/files.
    config.env.insert("COGNIA_GATEWAY_TASK_CONFIG".into(), payload.to_string());
    let owner = person.account_id.clone(); let runtime = runtime.to_owned(); let task_check = task.clone();
    Ok(GatewayAuthority { delivery_source: None, port, device_id: Some(format!("brain-{}", person.account_id)), task_id: task,
        authorized: Arc::new(move || gateway.person_validate_task_secret(&owner, &member, &runtime, &task_check, &secret).is_ok()) })
}

/// P6d mirrors the existing gateway-task launch contract with Host-produced
/// config only. All credential-looking values below are the validated lease
/// secret or a reference to it; the org key never leaves the gateway.
fn person_broker_configuration(config: &mut ExternalAgentSpawnConfig, payload: &mut Value, family: &str,
    runtime: &str, model: &str, port: u16, secret: &str) {
    let endpoint = format!("http://127.0.0.1:{port}/v1");
    match family {
        "codex" => {
            let provider = json!({"name":"Cognia","base_url":endpoint,"env_key":"COGNIA_GATEWAY_TOKEN","wire_api":"responses","requires_openai_auth":false});
            let settings = json!({"model":model,"review_model":model,"model_provider":"cognia","model_providers":{"cognia":provider}});
            let toml = format!("model = {}\nreview_model = {}\nmodel_provider = \"cognia\"\n[model_providers.cognia]\nname = \"Cognia\"\nbase_url = {}\nenv_key = \"COGNIA_GATEWAY_TOKEN\"\nwire_api = \"responses\"\nrequires_openai_auth = false\n",
                json!(model), json!(model), json!(endpoint));
            payload["files"]["codex/config.toml"] = json!(toml);
            if runtime == "codex-acp" {
                config.env.insert("MODEL_PROVIDER".into(), "cognia".into());
                config.env.insert("CODEX_CONFIG".into(), settings.to_string());
            } else {
                for setting in [format!("model={}",json!(model)), "model_provider=\"cognia\"".into(),
                    format!("model_providers.cognia.base_url={}",json!(endpoint)), "model_providers.cognia.name=\"Cognia\"".into(),
                    "model_providers.cognia.env_key=\"COGNIA_GATEWAY_TOKEN\"".into(), "model_providers.cognia.wire_api=\"responses\"".into(),
                    "model_providers.cognia.requires_openai_auth=false".into()] {
                    config.args.extend(["-c".into(), setting]);
                }
            }
        }
        "pi" => {
            payload["files"]["pi/models.json"] = json!(json!({"providers":{"cognia":{"baseUrl":endpoint,
                "api":"openai-completions","apiKey":"$COGNIA_GATEWAY_TOKEN","models":[{"id":model,"name":model,"input":["text"]}]}}}).to_string());
            payload["files"]["pi/settings.json"] = json!(json!({"defaultProvider":"cognia","defaultModel":model,"enabledModels":[format!("cognia/{model}")]}).to_string());
        }
        "qwen" => {
            config.env.extend([("OPENAI_API_KEY".into(),secret.into()),("OPENAI_BASE_URL".into(),endpoint.clone()),("OPENAI_MODEL".into(),model.into())]);
            payload["files"]["qwen/settings.json"] = json!(json!({"$version":4,"security":{"auth":{"selectedType":"openai"}},
                "general":{"enableAutoUpdate":false,"disableAutoUpdate":true},"telemetry":{"enabled":false},"privacy":{"usageStatisticsEnabled":false},
                "model":{"name":model},"fastModel":model,"advisorModel":model,"compactionModel":model,
                "modelProviders":{"openai":[{"id":model,"name":model,"envKey":"COGNIA_GATEWAY_TOKEN","baseUrl":endpoint}]}}).to_string());
            config.args.extend(["--auth-type".into(),"openai".into(),"--model".into(),model.into(),"--openai-base-url".into(),endpoint]);
        }
        "opencode" => {
            let model_entry = json!({"name":model,"tool_call":true,"modalities":{"input":["text"],"output":["text"]}});
            let provider = json!({"name":"Cognia","npm":"@ai-sdk/openai-compatible",
                "options":{"baseURL":endpoint,"apiKey":"{env:COGNIA_GATEWAY_TOKEN}"},"models":{(model):model_entry}});
            config.env.insert("OPENCODE_CONFIG_CONTENT".into(), json!({"model":format!("cognia/{model}"),"small_model":format!("cognia/{model}"),
                "enabled_providers":["cognia"],"provider":{"cognia":provider}}).to_string());
            config.env.insert("OPENCODE_DISABLE_PROJECT_CONFIG".into(),"true".into());
        }
        "copilot" => {
            config.env.extend([("COPILOT_PROVIDER_BASE_URL".into(),endpoint),("COPILOT_PROVIDER_TYPE".into(),"openai".into()),
                ("COPILOT_PROVIDER_WIRE_API".into(),"completions".into()),("COPILOT_PROVIDER_API_KEY".into(),secret.into()),
                ("COPILOT_MODEL".into(),model.into()),("COPILOT_OFFLINE".into(),"true".into()),("COPILOT_AUTO_UPDATE".into(),"false".into())]);
            for name in ["COPILOT_GITHUB_TOKEN","GH_TOKEN","GITHUB_TOKEN"] { config.env.insert(name.into(),"cognia-gateway-no-github-auth".into()); }
            config.args.extend(["--model".into(),model.into()]);
        }
        "claude" => {
            config.env.insert("ANTHROPIC_BASE_URL".into(),endpoint.trim_end_matches("/v1").into());
            config.env.insert("ANTHROPIC_AUTH_TOKEN".into(),secret.into());
            for name in ["ANTHROPIC_MODEL","ANTHROPIC_DEFAULT_OPUS_MODEL","ANTHROPIC_DEFAULT_SONNET_MODEL","ANTHROPIC_DEFAULT_HAIKU_MODEL"] {
                config.env.insert(name.into(),model.into());
            }
        }
        _ => unreachable!("only the reviewed bundled gateway families are admitted"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn person(user: &str) -> PersonPartition { PersonPartition::new("org_p6d_lease".into(), user.into()) }
    fn gateway() -> GatewayState {
        let gateway = GatewayState::new();
        gateway.try_set_snapshot(serde_json::from_value(json!({"generatedAtMs":1,"providers":[{
            "id":"p6d-provider","protocol":"openai","enabled":true,"baseUrl":"https://fixture.invalid/v1",
            "apiKey":"operator-must-not-use","models":["p6d-model"]}]})).unwrap()).unwrap();
        gateway
    }
    fn request(runtime: &str) -> PersonAgentLeaseRequest { PersonAgentLeaseRequest {
        runtime_id:runtime.into(), provider:"p6d-provider".into(), model:"p6d-model".into(), session_id:Some("p6d-lease-task".into())
    } }
    #[test]
    fn p6d_every_brokered_runtime_generates_valid_private_task_configuration() {
        let catalog: Value = serde_json::from_str(include_str!("../../../protocol/external-agent-runtimes.json")).unwrap();
        let policy = cognia_companion::org_agent_policy::get("org_p6d_launch_configs").unwrap();
        for runtime in policy.bundled_agents {
            let Some(family) = cognia_companion::org_agent_policy::person_runtime_family(&runtime.runtime_id) else { continue; };
            let temp = tempfile::tempdir().unwrap();
            let row = catalog["runtimes"].as_array().unwrap().iter().find(|row| row["runtimeId"] == runtime.runtime_id).unwrap();
            let mut config: ExternalAgentSpawnConfig = serde_json::from_value(json!({"id":"p6d-agent","command":row["systemCommand"],
                "args":row["launchArgs"],"cwd":temp.path().to_str().unwrap(),"env":{"COGNIA_GATEWAY_TOKEN":"p6d-task-secret"}})).unwrap();
            let mut payload = json!({"taskId":format!("p6d-{}",runtime.runtime_id),"runtime":family,"binding":{"providerId":"provider","modelId":"model"},"files":{}});
            person_broker_configuration(&mut config,&mut payload,family,&runtime.runtime_id,"model",19384,"p6d-task-secret");
            config.env.insert("COGNIA_GATEWAY_TASK_CONFIG".into(),payload.to_string());
            cognia_gateway::task_lease::validate_task_endpoints(&config.env,&config.args,&payload,"http://127.0.0.1:19384/v1").unwrap();
            let validated = cognia_external_agent::presets::SpawnPolicy::new(temp.path().into(),false).validate(config).unwrap();
            assert!(validated.dropped_env_keys.is_empty(),"{}: {:?}",runtime.runtime_id,validated.dropped_env_keys);
            let mut env = validated.config.env;
            let _files = cognia_external_agent::gateway_task::prepare(&mut env,temp.path()).unwrap().unwrap();
            assert!(std::path::Path::new(&env["HOME"]).starts_with(temp.path().canonicalize().unwrap()));
            for contents in payload["files"].as_object().unwrap().values() {
                assert!(!contents.as_str().unwrap().contains("p6d-task-secret"));
            }
        }
    }
    #[test]
    fn p6d_lease_member_override_cap_and_cross_partition_runtime_fences() {
        let gateway = gateway(); let a = person("usr_p6d_lease_a"); let b = person("usr_p6d_lease_b");
        cognia_companion::org_credentials::OrgCredentials::set(&a.org_id,"p6d-provider","p6d-org-lease-key","operator",1).unwrap();
        cognia_companion::org_agent_policy::set(&a.org_id,vec!["pi".into(),"codex-acp".into()],Some("pi".into()),"operator",1).unwrap();
        let minted = person_lease_mint(&a,request("pi"),&gateway).unwrap();
        assert!(!minted.to_string().contains("p6d-org-lease-key"));
        let secret = minted["secret"].as_str().unwrap(); let task = minted["ticketId"].as_str().unwrap();
        assert!(gateway.person_validate_task_secret(&a.account_id,&person_member(&a),"pi",task,secret).is_ok());
        assert!(gateway.person_validate_task_secret(&b.account_id,&person_member(&b),"pi",task,secret).is_err());
        assert!(gateway.person_validate_task_secret(&a.account_id,&person_member(&a),"codex-acp",task,secret).is_err());
        let now = chrono::Utc::now().timestamp_millis(); let ticket = gateway.tickets.validate(secret,now).unwrap();
        assert_eq!(ticket.member,Some(person_member(&a)));
        assert_eq!(ticket.owner_account_id.as_deref(),Some(a.account_id.as_str()));
        let overrides = gateway.tickets.provider_overrides(&ticket.ticket_id);
        assert_eq!(overrides[0].api_key.as_deref(),Some("p6d-org-lease-key"));
        gateway.tickets.org_usage_cap_set(&a.org_id,None,Some(Some(10))).unwrap();
        use cognia_gateway::route_ticket::{TicketOperation, TicketReject};
        gateway.tickets.validate_and_reserve(secret,now,TicketOperation::Chat,"p6d-first",8).unwrap();
        assert!(matches!(gateway.tickets.validate_and_reserve(secret,now,TicketOperation::Chat,"p6d-over",3),Err(TicketReject::MemberUsageCapReached { .. })));
        gateway.tickets.settle_reservation("p6d-first",8);
        assert!(matches!(gateway.tickets.validate_and_reserve(secret,now,TicketOperation::Chat,"p6d-after",3),Err(TicketReject::MemberUsageCapReached { .. })));
        assert_eq!(gateway.tickets.person_revoke_provider(&a.org_id,"p6d-provider"),1);
        assert!(gateway.person_validate_task_secret(&a.account_id,&person_member(&a),"pi",task,secret).is_err());
        assert_eq!(person_lease_mint(&a,request("opencode"),&gateway).unwrap_err().1.code,"org_agent_not_allowed");
        cognia_companion::org_credentials::OrgCredentials::delete(&a.org_id,"p6d-provider").unwrap();
        assert_eq!(person_lease_mint(&a,request("pi"),&gateway).unwrap_err().1.code,"model_access_unavailable");
    }
    #[test]
    fn p6d_unknown_model_and_quota_details_are_precise() {
        let gateway = gateway(); let a = PersonPartition::new("org_p6d_model_refusal".into(),"usr_p6d_model_refusal".into());
        cognia_companion::org_credentials::OrgCredentials::set(&a.org_id,"p6d-provider","key","operator",1).unwrap();
        cognia_companion::org_agent_policy::set(&a.org_id,vec!["pi".into()],None,"operator",1).unwrap();
        let mut unknown = request("pi"); unknown.model = "unknown".into();
        assert_eq!(person_lease_mint(&a,unknown,&gateway).unwrap_err().0,StatusCode::BAD_REQUEST);
        let error = person_workspace_error(cognia_external_agent::person_workspace::PersonWorkspaceError::Quota { used_bytes:123,max_bytes:100 });
        assert_eq!(error.0,StatusCode::INSUFFICIENT_STORAGE);
        assert_eq!(error.1.details,Some(json!({"usedBytes":123,"maxBytes":100})));
    }
    #[tokio::test]
    async fn p6d_task_mint_refuses_every_non_person_caller() {
        let state = crate::rpc::tests::test_state();
        let host = crate::headless::HeadlessServices::stub_for_tests();
        for scope in [None, Some("service"), Some("owner"), Some("device")] {
            assert_eq!(person_agent_lease_prepare(json!({}),scope,None,&state,&host).await.unwrap_err().0,StatusCode::FORBIDDEN);
        }
    }
}
