//! P6c partition-only model brokerage. Kept separate from operator provider
//! administration so the sole org value reader cannot become a generic RPC.
use axum::{http::StatusCode, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use cognia_companion::{deployment::DeploymentMode, person_partition::PersonPartition, rpc_error::RpcError};
use cognia_gateway::{GatewayState, route_ticket::{MemberBinding, MintRequest, TicketAffinity, TicketCandidate, default_ticket_operations}};

type PersonResult<T> = Result<T, (StatusCode, Json<RpcError>)>;
pub fn person_forbidden() -> (StatusCode, Json<RpcError>) {
    (StatusCode::FORBIDDEN, Json(RpcError::new("host_surface_forbidden", "host_surface_forbidden")))
}
/// A refused tool-less send, with the reason logged; the caller only sees the code.
fn person_send_refused(reason: &'static str) -> (StatusCode, Json<RpcError>) {
    log::warn!("person chat send refused: {reason}");
    person_forbidden()
}
fn person_unavailable() -> (StatusCode, Json<RpcError>) {
    (StatusCode::SERVICE_UNAVAILABLE, Json(RpcError::new("model_access_unavailable", "model_access_unavailable")))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PersonModelRequest { pub provider: String, pub model: String, pub session_id: String }

/// Called only in a blocking worker; rotation uses the same synchronous fence.
pub fn person_mint(mode: DeploymentMode, person: &PersonPartition, request: PersonModelRequest,
    gateway: &GatewayState, port: u16) -> PersonResult<Value> {
    cognia_companion::org_policy::require_mode(mode)
        .map_err(|problem| (problem.status_code(), Json(RpcError::new(problem.code, problem.detail))))?;
    if request.provider.is_empty() || request.model.is_empty() || request.session_id.is_empty() {
        return Err(RpcError::malformed("invalid person model request".into()));
    }
    let _p6c_fence = cognia_companion::org_policy::PERSON_CREDENTIAL_FENCE.lock();
    let key = cognia_companion::org_credentials::OrgCredentials::org_provider_key(&person.org_id, &request.provider)
        .map_err(|_| person_unavailable())?.ok_or_else(person_unavailable)?;
    let fingerprint = cognia_companion::org_credentials::OrgCredentials::list(&person.org_id)
        .map_err(|_| person_unavailable())?.into_iter().find(|entry| entry.provider == request.provider)
        .ok_or_else(person_unavailable)?.fingerprint;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as i64;
    gateway.with_snapshot(|snapshot| {
        let snapshot = snapshot.ok_or_else(person_unavailable)?;
        let mut provider = snapshot.provider(&request.provider).cloned().ok_or_else(person_unavailable)?;
        if !provider.models.contains(&request.model) { return Err(RpcError::malformed("invalid model".into())); }
        provider.api_key = Some(key);
        provider.api_keys.clear();
        provider.rotation_enabled = false;
        provider.rotation_strategy = None;
        let deployment_id = provider.deployment_id.clone().unwrap_or_else(|| provider.id.clone());
        let minted = gateway.tickets.person_mint_owned(MintRequest {
            provider_overrides: vec![provider], session_id: request.session_id,
            parent_session_id: None, execution_fingerprint: format!("person_p6c_{}", uuid::Uuid::new_v4()),
            candidates: vec![TicketCandidate { deployment_id, model_id: request.model.clone() }],
            model_bindings: std::collections::BTreeMap::from([(request.model.clone(), request.model.clone())]),
            strict_selectors: true, credential_affinity: TicketAffinity::SessionSticky,
            allow_auth_failover: false, route_policy: "person_p6c_tool_less".into(), ttl_ms: Some(900_000),
            model: Some(request.model.clone()), operations: Some(default_ticket_operations()), budget: None,
        }, Some(snapshot), now, Some(person.account_id.clone()), Some(MemberBinding {
            org_id: person.org_id.clone(), user_id: person.user_id.clone(),
        })).map_err(|_| person_unavailable())?;
        Ok(json!({"ticketId":minted.ticket.ticket_id, "secret":minted.secret,
            "endpoint":format!("http://127.0.0.1:{port}/v1"), "gatewayPort":port,
            "provider":request.provider, "model":request.model,
            "expiresAt":minted.ticket.expires_at_ms, "credentialFingerprint":fingerprint}))
    })
}

pub async fn person_model_ticket_mint(args: Value, scope: Option<&str>, tenant: Option<&str>,
    state: &cognia_companion::SharedState, host: &dyn crate::rpc_host::RpcHost) -> PersonResult<Value> {
    if scope != Some("person-brain") { return Err(person_forbidden()); }
    let person = cognia_companion::person_partition::current().filter(|person| Some(person.account_id.as_str()) == tenant)
        .ok_or_else(person_forbidden)?;
    cognia_companion::org_policy::require_mode(cognia_companion::deployment::deployment_mode())
        .map_err(|problem| (problem.status_code(), Json(RpcError::new(problem.code, problem.detail))))?;
    let request: PersonModelRequest = serde_json::from_value(args).map_err(|_| RpcError::malformed("invalid person model request".into()))?;
    let provider = request.provider.clone(); let model = request.model.clone();
    let shared = host.to_shared(); let audit_person = person.clone();
    let (mut result, generation) = tokio::task::spawn_blocking(move || {
        let gateway = shared.gateway().ok_or_else(person_unavailable)?;
        let generation = gateway.status().account_generation;
        // The port is filled in once the ticket-only listener is confirmed.
        person_mint(cognia_companion::deployment::deployment_mode(), &person, request, gateway, 0)
            .map(|minted| (minted, generation))
    }).await.map_err(|_| person_unavailable())??;
    let ticket_id = result["ticketId"].as_str().unwrap_or_default().to_string();
    let port = person_ensure_listener(state, host, &ticket_id, generation).await?;
    result["endpoint"] = json!(format!("http://127.0.0.1:{port}/v1"));
    result["gatewayPort"] = json!(port);
    cognia_companion::audit::record_async("person_model_ticket_mint", &format!("brain-{}", audit_person.account_id), "person-brain", "allow",
        json!({"orgId":audit_person.org_id,"userId":audit_person.user_id,"provider":provider,"model":model,"ticketId":result["ticketId"]})).await;
    Ok(result)
}

/// A Host serves partition tickets on the ticket-only gateway listener (the
/// same one task leases use): started on demand, so no reusable gateway key
/// is needed. Mirrors `ensure_task_listener`: any failure, or an account
/// switch since the mint, revokes the ticket so the brain never holds one it
/// cannot use.
async fn person_ensure_listener(state: &cognia_companion::SharedState, host: &dyn crate::rpc_host::RpcHost,
    ticket_id: &str, generation: u64) -> PersonResult<u16> {
    let gateway = host.gateway().ok_or_else(person_unavailable)?;
    let started = if gateway.status().running { Ok(()) } else {
        gateway.start_for_task(host.gateway_event_host(std::sync::Arc::clone(&state.event_bus)), ticket_id).await
    };
    let status = gateway.status();
    match status.bound_port.filter(|_| status.running) {
        Some(port) if !(started.is_err() && !status.running) && status.account_generation == generation => Ok(port),
        _ => {
            // Not `revoke_route_ticket`: that only revokes tickets the gateway's
            // own (operator) account owns, and this one belongs to the partition.
            gateway.tickets.revoke(ticket_id);
            Err(person_unavailable())
        }
    }
}

/// Exact allowlist: model, systemPrompt, appendSystemPrompt, traceparent,
/// includePartialMessages, initialConversation, transcriptGeneration, and turnId; providerCredentials contributes only a
/// verified ticket secret. sessionId/prompt/commandId/messageId live on the
/// outer agent_send request. Everything else is discarded, including nested
/// execution specs. The gateway uses an OpenAI chat client regardless of the
/// org upstream protocol; the gateway translates against its frozen override.
pub fn person_send_options(input: cognia_sidecar::commands::SendOptions, session: &str,
    person: &PersonPartition, gateway: &GatewayState, port: u16, scratch: String) -> PersonResult<cognia_sidecar::commands::SendOptions> {
    use cognia_sidecar::commands::{SendOptions, ProviderCredentials};
    let endpoint = format!("http://127.0.0.1:{port}/v1");
    let credentials = input.provider_credentials.ok_or_else(|| person_send_refused("no gateway credentials"))?;
    if credentials.base_url.as_deref() != Some(&endpoint) { return Err(person_send_refused("base url is not the Host gateway")); }
    let secret = credentials.api_key.ok_or_else(|| person_send_refused("no ticket secret"))?;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as i64;
    let ticket = gateway.tickets.validate(&secret, now).map_err(|_| person_send_refused("ticket invalid or expired"))?;
    if ticket.owner_account_id.as_deref() != Some(&person.account_id) || ticket.session_id != session
        || ticket.member.as_ref() != Some(&MemberBinding { org_id:person.org_id.clone(), user_id:person.user_id.clone() })
        || !input.model.as_ref().is_some_and(|model| ticket.candidates.iter().any(|candidate| &candidate.model_id == model)) {
        return Err(person_send_refused("ticket does not cover this partition, session and model"));
    }
    let mut extra = std::collections::HashMap::from([
        ("toolSurface".into(), json!("none")), ("hooks".into(), json!({})),
        ("plugins".into(), json!([])), ("skills".into(), json!([])),
        ("execution".into(), json!({"specVersion":2,"runtimeAdapter":"ai-sdk","capabilities":{"effective":[]}})),
    ]);
    if let Some(turn) = input.extra.get("turnId").and_then(Value::as_str) { extra.insert("turnId".into(), json!(turn)); }
    if let Some(history) = input.extra.get("initialConversation").filter(|value| value.is_array()) { extra.insert("initialConversation".into(), history.clone()); }
    if let Some(generation) = input.extra.get("transcriptGeneration").and_then(Value::as_u64) { extra.insert("transcriptGeneration".into(), json!(generation)); }
    Ok(SendOptions { person_tool_less:true, model:input.model, system_prompt:input.system_prompt, append_system_prompt:input.append_system_prompt,
        traceparent:input.traceparent, include_partial_messages:input.include_partial_messages,
        cwd:Some(scratch), provider:Some("openai".into()),
        provider_credentials:Some(ProviderCredentials { api_key:Some(secret), base_url:Some(endpoint),
            protocol:Some("openai".into()), api_flavor:Some("chat".into()), ..Default::default() }),
        allowed_tools:Some(vec![]), mcp_servers:Some(Default::default()), strict_mcp_config:Some(true),
        permission_mode:Some("plan".into()), env:Some(Default::default()), setting_sources:Some(vec![]),
        agents:Some(Default::default()), additional_directories:Some(vec![]), max_turns:Some(1),
        extra, ..Default::default() })
}

/// P6c agent_send's person branch. `port` is resolved by the Host adapter from
/// its running gateway; it is never read from a request.
pub(crate) async fn person_send_turn(host: &dyn crate::rpc_host::RpcHost,
    person: &PersonPartition, port: u16, session_id: String, prompt: Value,
    options: Option<cognia_sidecar::commands::SendOptions>, command_id: Option<String>) -> PersonResult<Value> {
    let gateway = host.gateway().ok_or_else(person_forbidden)?;
    let scratch = host.data_dir().map_err(RpcError::internal)?
        .join("persons").join(&person.account_id).join("person-chat-scratch");
    let mut options = person_send_options(options.unwrap_or_default(), &session_id, person,
        gateway, port, scratch.to_string_lossy().into_owned())?;
    cognia_companion::person_chat::PERSON_SESSIONS.bind(&session_id, Some(person))
        .map_err(|_| person_send_refused("session belongs to another partition"))?;
    std::fs::create_dir_all(&scratch).map_err(|_| RpcError::internal("person chat scratch unavailable".into()))?;
    // The sidecar starts in its script directory, so a relative Host data dir
    // must be resolved here rather than interpreted in the child's cwd.
    options.cwd = Some(std::fs::canonicalize(&scratch)
        .map_err(|_| RpcError::internal("person chat scratch unavailable".into()))?.to_string_lossy().into_owned());
    cognia_sidecar::commands::claude_send_with_host_and_id(host.sidecar_host(), host.sidecar_state(),
        session_id, prompt, Some(options), command_id).await.map(|_| Value::Null).map_err(RpcError::internal)
}

#[cfg(test)]
mod tests {
    use super::*;
    use cognia_companion::deployment::DeploymentMode::{MultiTenant, SingleUser};
    use cognia_companion::org_credentials::OrgCredentials;
    use cognia_gateway::route_ticket::{TicketOperation, TicketReject};
    use cognia_sidecar::commands::SendOptions;
    static PERSON_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    fn person(user: &str) -> PersonPartition { PersonPartition::new("org_p6c_model".into(), user.into()) }
    fn gateway() -> GatewayState {
        let gateway = GatewayState::new();
        gateway.try_set_snapshot(serde_json::from_value(json!({"generatedAtMs":1,"providers":[{
            "id":"p6c-provider","deploymentId":"p6c-deployment","protocol":"anthropic",
            "baseUrl":"https://fixture.invalid/v1","apiKey":"operator-key-never-used",
            "apiKeys":["operator-rotation-key"],"rotationEnabled":true,"enabled":true,"models":["p6c-model"]
        }]})).unwrap()).unwrap();
        gateway
    }
    fn request(session: &str) -> PersonModelRequest {
        PersonModelRequest { provider:"p6c-provider".into(), model:"p6c-model".into(), session_id:session.into() }
    }
    fn options(minted: &Value) -> SendOptions {
        serde_json::from_value(json!({"model":minted["model"],"providerCredentials":{
            "apiKey":minted["secret"],"baseURL":minted["endpoint"],"protocol":"openai","apiFlavor":"chat"}})).unwrap()
    }
    fn assert_error<T>(result: PersonResult<T>, status: StatusCode, code: &str) {
        let Err((actual, body)) = result else { panic!("expected {code}"); };
        assert_eq!(actual, status); assert_eq!(body.0.code, code);
    }
    #[tokio::test]
    async fn p6c_mint_starts_the_ticket_only_listener_and_revokes_on_account_switch() {
        let _p6c_lock = PERSON_TEST_LOCK.lock().await;
        let host = crate::headless::HeadlessServices::stub_for_tests();
        host.gateway.try_set_snapshot(gateway().with_snapshot(|snapshot| snapshot.cloned()).unwrap()).unwrap();
        // Port 0: the OS picks at bind, so parallel suites never race for a port.
        let mut config = host.gateway.config(); config.port = 0;
        host.gateway.update_config(config).unwrap();
        assert!(!host.gateway.status().running);
        let a = person("usr_p6c_listener");
        OrgCredentials::set(&a.org_id, "p6c-provider", "p6c-listener-key", "operator", 1).unwrap();
        let state = crate::rpc::tests::test_state();
        let generation = host.gateway.status().account_generation;
        // No gateway key exists: the ticket alone authorizes the listener.
        let minted = person_mint(MultiTenant, &a, request("p6c-listener"), &host.gateway, 0).unwrap();
        let bound = person_ensure_listener(&state, &host, minted["ticketId"].as_str().unwrap(), generation).await.unwrap();
        assert!(host.gateway.status().running);
        assert_eq!(host.gateway.status().bound_port, Some(bound));
        // An account switch since the mint revokes the ticket instead of serving it.
        let stale = person_mint(MultiTenant, &a, request("p6c-listener-stale"), &host.gateway, 0).unwrap();
        assert_error(person_ensure_listener(&state, &host, stale["ticketId"].as_str().unwrap(), generation + 1).await,
            StatusCode::SERVICE_UNAVAILABLE, "model_access_unavailable");
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
        assert!(host.gateway.tickets.validate(stale["secret"].as_str().unwrap(), now).is_err());
        host.gateway.stop().unwrap();
        OrgCredentials::delete(&a.org_id, "p6c-provider").unwrap();
    }
    #[test]
    fn p6c_mint_binds_member_uses_snapshot_and_never_returns_org_key() {
        let _p6c_lock = PERSON_TEST_LOCK.blocking_lock();
        let gateway = gateway(); let a = person("usr_p6c_mint");
        let key = "p6c-org-credential-not-for-the-brain";
        let metadata = OrgCredentials::set(&a.org_id, "p6c-provider", key, "operator", 1).unwrap();
        let result = person_mint(MultiTenant, &a, request("p6c-mint"), &gateway, 19384).unwrap();
        let ticket = gateway.tickets.validate(result["secret"].as_str().unwrap(), 1).unwrap();
        assert_eq!(ticket.owner_account_id.as_deref(), Some(a.account_id.as_str()));
        assert_eq!(ticket.member, Some(MemberBinding { org_id:a.org_id, user_id:a.user_id }));
        assert_eq!(ticket.session_id, "p6c-mint"); assert!(ticket.budget.is_none());
        assert_eq!(ticket.operations, default_ticket_operations());
        assert_eq!(ticket.expires_at_ms - ticket.issued_at_ms, 900_000);
        assert_eq!(result["credentialFingerprint"], metadata.fingerprint);
        assert!(!result.to_string().contains(key));
        assert_eq!(result.as_object().unwrap().len(), 8);
        let overrides = gateway.tickets.provider_overrides(&ticket.ticket_id);
        assert_eq!(overrides[0].api_key.as_deref(), Some(key));
        assert!(overrides[0].api_keys.is_empty()); assert!(!overrides[0].rotation_enabled);
        assert_eq!(overrides[0].base_url, "https://fixture.invalid/v1");
        assert_eq!(overrides[0].protocol, "anthropic");
        assert_eq!(overrides[0].deployment_id.as_deref(), Some("p6c-deployment"));
        assert_eq!(gateway.with_snapshot(|snapshot| snapshot.unwrap().providers[0].api_key.clone()).as_deref(), Some("operator-key-never-used"));
    }
    #[tokio::test]
    async fn p6c_mint_refusals_are_closed_and_non_person_callers_are_forbidden() {
        let _p6c_lock = PERSON_TEST_LOCK.lock().await;
        let gateway = gateway(); let a = person("usr_p6c_refusal");
        assert_error(person_mint(SingleUser, &a, request("s"), &gateway, 19384), StatusCode::CONFLICT, "org_scope_unavailable");
        let mut missing = request("s"); missing.provider = "p6c-absent-credential".into();
        assert_error(person_mint(MultiTenant, &a, missing, &gateway, 19384), StatusCode::SERVICE_UNAVAILABLE, "model_access_unavailable");
        OrgCredentials::set(&a.org_id, "p6c-missing-provider", "org-key", "operator", 1).unwrap();
        let mut missing = request("s"); missing.provider = "p6c-missing-provider".into();
        assert_error(person_mint(MultiTenant, &a, missing, &gateway, 19384), StatusCode::SERVICE_UNAVAILABLE, "model_access_unavailable");
        OrgCredentials::set(&a.org_id, "p6c-provider", "org-key", "operator", 1).unwrap();
        let mut unknown = request("s"); unknown.model = "unknown-model".into();
        assert_error(person_mint(MultiTenant, &a, unknown, &gateway, 19384), StatusCode::BAD_REQUEST, "malformed_request");
        let host = crate::headless::HeadlessServices::stub_for_tests();
        let state = crate::rpc::tests::test_state();
        for scope in [None, Some("service"), Some("device"), Some("owner")] {
            assert_error(person_model_ticket_mint(json!({}), scope, None, &state, &host).await, StatusCode::FORBIDDEN, "host_surface_forbidden");
        }
    }
    #[test]
    fn p6c_ac33_foreign_ticket_session_model_and_non_gateway_credentials_are_refused() {
        let _p6c_lock = PERSON_TEST_LOCK.blocking_lock();
        let gateway = gateway(); let a = person("usr_p6c_ticket_a"); let b = person("usr_p6c_ticket_b");
        OrgCredentials::set(&a.org_id, "p6c-provider", "p6c-key", "operator", 1).unwrap();
        let minted = person_mint(MultiTenant, &a, request("p6c-owned"), &gateway, 19384).unwrap();
        assert_error(person_send_options(options(&minted), "p6c-owned", &b, &gateway, 19384, "/scratch".into()), StatusCode::FORBIDDEN, "host_surface_forbidden");
        assert_error(person_send_options(options(&minted), "other-session", &a, &gateway, 19384, "/scratch".into()), StatusCode::FORBIDDEN, "host_surface_forbidden");
        let mut bad = options(&minted); bad.model = Some("unknown".into());
        assert_error(person_send_options(bad, "p6c-owned", &a, &gateway, 19384, "/scratch".into()), StatusCode::FORBIDDEN, "host_surface_forbidden");
        for endpoint in ["https://evil.invalid/v1", "http://127.0.0.1:19385/v1", "http://localhost:19384/v1"] {
            let mut bad = options(&minted); bad.provider_credentials.as_mut().unwrap().base_url = Some(endpoint.into());
            assert_error(person_send_options(bad, "p6c-owned", &a, &gateway, 19384, "/scratch".into()), StatusCode::FORBIDDEN, "host_surface_forbidden");
        }
        let mut bad = options(&minted); bad.provider_credentials.as_mut().unwrap().api_key = Some("ordinary-provider-key".into());
        assert_error(person_send_options(bad, "p6c-owned", &a, &gateway, 19384, "/scratch".into()), StatusCode::FORBIDDEN, "host_surface_forbidden");
    }
    #[test]
    fn p6c_ac34_minted_ticket_reserves_member_cap_without_affecting_another_member() {
        let _p6c_lock = PERSON_TEST_LOCK.blocking_lock();
        let gateway = gateway(); let a = person("usr_p6c_cap_a"); let b = person("usr_p6c_cap_b");
        OrgCredentials::set(&a.org_id, "p6c-provider", "p6c-key", "operator", 1).unwrap();
        gateway.tickets.org_usage_cap_set(&a.org_id, None, Some(Some(10))).unwrap();
        let first = person_mint(MultiTenant, &a, request("p6c-cap-a"), &gateway, 19384).unwrap();
        let second = person_mint(MultiTenant, &b, request("p6c-cap-b"), &gateway, 19384).unwrap();
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
        let secret = first["secret"].as_str().unwrap();
        gateway.tickets.validate_and_reserve(secret, now, TicketOperation::Chat, "p6c-first", 8).unwrap();
        assert!(matches!(gateway.tickets.validate_and_reserve(secret, now, TicketOperation::Chat, "p6c-over", 3), Err(TicketReject::MemberUsageCapReached { .. })));
        gateway.tickets.validate_and_reserve(second["secret"].as_str().unwrap(), now, TicketOperation::Chat, "p6c-second", 10).unwrap();
        gateway.tickets.settle_reservation("p6c-first", 8);
        assert!(matches!(gateway.tickets.validate_and_reserve(secret, now, TicketOperation::Chat, "p6c-mid-turn", 3), Err(TicketReject::MemberUsageCapReached { .. })));
    }

    struct PersonCaptureHost {
        script: std::path::PathBuf,
        frames: tokio::sync::mpsc::UnboundedSender<Value>,
    }
    #[async_trait::async_trait]
    impl cognia_sidecar::host::SidecarHost for PersonCaptureHost {
        fn resolve_script(&self) -> Result<std::path::PathBuf, String> { Ok(self.script.clone()) }
        fn emit(&self, _: &str, payload: &Value) { if let Some(frame) = payload.get("frame") { let _ = self.frames.send(frame.clone()); } }
        async fn inject_env(&self, _: &mut tokio::process::Command) {}
        fn is_disabled(&self) -> bool { false }
        fn report_failure(&self) {}
        async fn dispatch_host_rpc(&self, _: &str, _: &Value) -> Result<Value, String> { Err("unexpected host RPC".into()) }
        fn kind(&self) -> &'static str { "headless" }
    }
    #[tokio::test]
    async fn p6c_agent_send_writes_stripped_frame_and_fences_session_and_interrupt() {
        let _p6c_lock = PERSON_TEST_LOCK.lock().await;
        // The real server initializes proxy policy before starting its sidecar.
        // This fixture launches only the local stdin capture process.
        if cognia_net::proxy_config::current().is_err() {
            cognia_net::proxy_config::apply_current(Default::default()).unwrap();
        }
        let root = tempfile::tempdir().unwrap(); let script = root.path().join("p6c-capture.mjs");
        std::fs::write(&script, r#"import readline from 'node:readline';
console.log(JSON.stringify({type:'ready'}));
readline.createInterface({input:process.stdin}).on('line', line => {
  const frame = JSON.parse(line);
  console.log(JSON.stringify({type:'p6c_capture',sessionId:frame.sessionId,frame}));
});"#).unwrap();
        let (frames, mut received) = tokio::sync::mpsc::unbounded_channel();
        let mut host = crate::headless::HeadlessServices::stub_for_tests();
        let mutable = std::sync::Arc::get_mut(&mut host).unwrap();
        mutable.sidecar_host = std::sync::Arc::new(PersonCaptureHost { script, frames });
        mutable.data_dir = root.path().into();
        mutable.gateway = std::sync::Arc::new(gateway());
        let a = person("usr_p6c_frame_a"); let b = person("usr_p6c_frame_b");
        OrgCredentials::set(&a.org_id, "p6c-provider", "p6c-frame-org-key", "operator", 1).unwrap();
        let minted = person_mint(MultiTenant, &a, request("p6c-frame-session"), &host.gateway, 19384).unwrap();
        let mut malicious = serde_json::to_value(options(&minted)).unwrap();
        for (key, value) in [("toolSurface",json!("default")),("tools",json!(["bash"])),("allowedTools",json!(["bash"])),
            ("mcpServers",json!({"evil":{"command":"sh"}})),("plugins",json!(["evil"])),("hooks",json!({"Stop":["evil"]})),
            ("cwd",json!("/operator-private")),("env",json!({"PATH":"evil"})),("agents",json!({"evil":{}})),
            ("skills",json!(["evil"])),("settingSources",json!(["user","project"])),("permissionMode",json!("bypassPermissions")),
            ("execution",json!({"runtimeAdapter":"external","specVersion":999})),("taskWorkspace",json!({"evil":true})),
            ("pluginTools",json!(["evil"])),("resumeSessionId",json!("operator")),("additionalDirectories",json!(["/private"]))] {
            malicious[key] = value;
        }
        malicious["providerCredentials"]["protocol"] = json!("anthropic");
        malicious["providerCredentials"]["apiFlavor"] = json!("responses");
        malicious["providerCredentials"]["headers"] = json!({"Authorization":"evil"});
        malicious["providerCredentials"]["accessKeyId"] = json!("evil");
        malicious["initialConversation"] = json!([{"role":"assistant","content":"previous reply"}]);
        malicious["turnId"] = json!("p6c-turn");
        let sent = person_send_turn(&host, &a, 19384, "p6c-frame-session".into(), json!("hello"),
            Some(serde_json::from_value(malicious).unwrap()), Some("p6c-command".into())).await;
        assert!(sent.is_ok(), "{:?}", sent.err().map(|(_, body)| body.0));
        let frame = tokio::time::timeout(std::time::Duration::from_secs(10), received.recv()).await.unwrap().unwrap();
        assert_eq!(frame["type"], "send"); assert_eq!(frame["sessionId"], "p6c-frame-session");
        assert_eq!(frame["prompt"], "hello"); assert_eq!(frame["commandId"], "p6c-command");
        let opts = &frame["options"];
        for (key, expected) in [("toolSurface",json!("none")),("allowedTools",json!([])),("mcpServers",json!({})),
            ("hooks",json!({})),("plugins",json!([])),("skills",json!([])),("env",json!({})),("agents",json!({})),
            ("settingSources",json!([])),("permissionMode",json!("plan")),("additionalDirectories",json!([]))] { assert_eq!(opts[key], expected, "{key}"); }
        for key in ["tools","taskWorkspace","pluginTools","resumeSessionId","forkFromSessionId","trustedWorkspaceRoots"] { assert!(opts.get(key).is_none(), "{key}"); }
        assert_eq!(opts["execution"], json!({"runtimeAdapter":"ai-sdk","specVersion":2,"capabilities":{"effective":[]}}));
        assert_eq!(opts["cwd"], std::fs::canonicalize(root.path()).unwrap().join("persons").join(&a.account_id).join("person-chat-scratch").to_string_lossy().as_ref());
        assert!(std::path::Path::new(opts["cwd"].as_str().unwrap()).is_absolute());
        assert_eq!(opts["provider"], "openai");
        assert_eq!(opts["providerCredentials"], json!({"apiKey":minted["secret"],"baseURL":minted["endpoint"],"protocol":"openai","apiFlavor":"chat"}));
        assert!(!frame.to_string().contains("p6c-frame-org-key"));
        assert_eq!(opts["initialConversation"], json!([{"role":"assistant","content":"previous reply"}]));
        assert_eq!(opts["turnId"], "p6c-turn");
        assert_error(person_send_turn(&host, &b, 19384, "p6c-frame-session".into(), json!("steal-ticket"), Some(options(&minted)), None).await,
            StatusCode::FORBIDDEN, "host_surface_forbidden");
        cognia_companion::person_chat::PERSON_SESSIONS.bind("p6c-operator-used", None).unwrap();
        let occupied = person_mint(MultiTenant, &a, request("p6c-operator-used"), &host.gateway, 19384).unwrap();
        assert_error(person_send_turn(&host, &a, 19384, "p6c-operator-used".into(), json!("claim-operator"), Some(options(&occupied)), None).await,
            StatusCode::FORBIDDEN, "host_surface_forbidden");
        let b_ticket = person_mint(MultiTenant, &b, request("p6c-frame-session"), &host.gateway, 19384).unwrap();
        assert_error(person_send_turn(&host, &b, 19384, "p6c-frame-session".into(), json!("steal"), Some(options(&b_ticket)), None).await,
            StatusCode::FORBIDDEN, "host_surface_forbidden");
        let state = std::sync::Arc::new(cognia_companion::CompanionState {
            secret:parking_lot::RwLock::new(vec![0;32]), deny_list:std::sync::Arc::new(cognia_companion::deny_list::DenyList::new()),
            renderer:None, runtime:cognia_companion::runtime::unwired(),
            idempotency:std::sync::Arc::new(cognia_companion::idempotency::IdempotencyCache::new()), event_bus:cognia_companion::event_bus::EventBus::new(),
            sync_bridge:cognia_companion::sync_bridge::SyncBridge::new(), desktop_messages_bridge:cognia_companion::desktop_messages_bridge::DesktopMessagesBridge::new(),
            desktop_writes_bridge:cognia_companion::desktop_writes_bridge::DesktopWritesBridge::new(), sync_registry:cognia_companion::sync_registry::SyncTableRegistry::with_defaults(),
            rate_limiter:cognia_companion::rate_limit::RateLimiter::with_defaults(), push_tokens:cognia_companion::push::PushTokenRegistry::new(),
        });
        for scope in ["service", "owner"] {
            assert_error(crate::rpc::dispatch("agent_send", json!({"sessionId":"p6c-frame-session","prompt":"steal"}),
                &state, &host, "operator", Some("operator"), Some(scope), cognia_companion::remote_execution::ExecutionPlane::LoopbackPlaintext).await,
                StatusCode::FORBIDDEN, "host_surface_forbidden");
        }
        let foreign_interrupt = cognia_companion::person_partition::scope(Some(b.clone()),
            crate::rpc::dispatch("agent_interrupt", json!({"sessionId":"p6c-frame-session"}), &state, &host,
                &format!("brain-{}", b.account_id), Some(&b.account_id), Some("person-brain"), cognia_companion::remote_execution::ExecutionPlane::LoopbackPlaintext)).await;
        assert_error(foreign_interrupt, StatusCode::FORBIDDEN, "host_surface_forbidden");
        assert!(received.try_recv().is_err(), "refused turns must write no sidecar frame");
        let result = cognia_companion::person_partition::scope(Some(a.clone()),
            crate::rpc::dispatch("agent_interrupt", json!({"sessionId":"p6c-frame-session"}), &state, &host,
                &format!("brain-{}", a.account_id), Some(&a.account_id), Some("person-brain"), cognia_companion::remote_execution::ExecutionPlane::LoopbackPlaintext)).await;
        assert!(result.is_ok());
        assert_eq!(tokio::time::timeout(std::time::Duration::from_secs(5), received.recv()).await.unwrap().unwrap()["type"], "interrupt");
        // Close before a replayed turn: own and never-bound sessions close,
        // another owner's (person or operator) and the legacy alias are refused.
        let brain_dispatch = |person: PersonPartition, command: &'static str, session: &'static str| {
            let (state, host) = (state.clone(), host.clone());
            async move {
                cognia_companion::person_partition::scope(Some(person.clone()),
                    crate::rpc::dispatch(command, json!({"sessionId":session}), &state, &host,
                        &format!("brain-{}", person.account_id), Some(&person.account_id), Some("person-brain"),
                        cognia_companion::remote_execution::ExecutionPlane::LoopbackPlaintext)).await
            }
        };
        assert_error(brain_dispatch(b.clone(), "agent_close_session", "p6c-frame-session").await, StatusCode::FORBIDDEN, "host_surface_forbidden");
        assert_error(brain_dispatch(a.clone(), "agent_close_session", "p6c-operator-used").await, StatusCode::FORBIDDEN, "host_surface_forbidden");
        assert_error(brain_dispatch(a.clone(), "claude_close_session", "p6c-frame-session").await, StatusCode::FORBIDDEN, "host_surface_forbidden");
        assert!(received.try_recv().is_err(), "refused closes must write no sidecar frame");
        for session in ["p6c-frame-session", "p6c-never-bound"] {
            assert!(brain_dispatch(a.clone(), "agent_close_session", session).await.is_ok(), "{session}");
            let frame = tokio::time::timeout(std::time::Duration::from_secs(5), received.recv()).await.unwrap().unwrap();
            assert_eq!((frame["type"].as_str(), frame["sessionId"].as_str()), (Some("close"), Some(session)));
        }
        cognia_sidecar::supervisor::shutdown_sidecar(host.sidecar.clone()).await.unwrap();
    }
}
