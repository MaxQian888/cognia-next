//! Device-owned, short-lived task delegation. Provider credentials are private
//! ticket overrides, never a global snapshot or a reusable Host API key.
use crate::{
    route_ticket::*,
    snapshot::{ProviderSnapshot, RoutingSnapshot},
    GatewayState,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const TASK_LEASE_TTL_MS: i64 = 120_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskLeaseRequest {
    pub task_id: String,
    pub provider: ProviderSnapshot,
    pub model: String,
    pub ingress_protocol: String,
    #[serde(skip)]
    pub upstream_client: Option<reqwest::Client>,
    #[serde(skip)]
    pub authority: Option<std::sync::Arc<dyn Fn() -> bool + Send + Sync>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskLease {
    pub ticket_id: String,
    pub secret: String,
    pub account_generation: u64,
    pub owner_account_id: Option<String>,
    pub expires_at_ms: i64,
}

pub(crate) fn empty_snapshot() -> RoutingSnapshot {
    RoutingSnapshot {
        aliases: vec![],
        providers: vec![],
        generated_at_ms: chrono::Utc::now().timestamp_millis(),
        routing_policy: None,
        profile_version: None,
        authority: None,
        router_fusion: None,
    }
}

fn scope(tenant: &str, device: &str, task: &str) -> Result<String, String> {
    if tenant.is_empty()
        || device.is_empty()
        || task.is_empty()
        || task.len() > 128
        || !task
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err("invalid gateway task identity".into());
    }
    Ok(serde_json::to_string(&("remote-task", tenant, device, task)).expect("strings serialize"))
}

/// A desktop-local URL would resolve against the runner's network. Refuse it
/// before accepting credentials; the request-scoped provider is HTTPS only.
pub async fn validate_public_upstream(value: &str) -> Result<reqwest::Client, String> {
    let url = reqwest::Url::parse(value).map_err(|_| "invalid task upstream URL")?;
    let host = url.host_str().ok_or("task upstream requires a host")?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || !host.contains('.')
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
    {
        return Err(
            "remote tasks require a public HTTPS upstream; local providers need a service bridge"
                .into(),
        );
    }
    let addresses: Vec<_> =
        tokio::net::lookup_host((host, url.port_or_known_default().unwrap_or(443)))
            .await
            .map_err(|_| "task upstream DNS resolution failed")?
            .collect();
    if addresses.is_empty()
        || addresses
            .iter()
            .any(|a| cognia_net::egress::is_forbidden_dest_ip(&a.ip()))
    {
        return Err("remote tasks cannot use private or loopback upstreams".into());
    }
    cognia_net::proxy_config::ensure_crypto_provider();
    reqwest::Client::builder()
        .no_proxy()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .resolve_to_addrs(host, &addresses)
        .connect_timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|_| "task upstream client initialization failed".into())
}

impl GatewayState {
    pub fn mint_task_lease(
        &self,
        tenant: &str,
        device: &str,
        expected_generation: u64,
        mut input: TaskLeaseRequest,
    ) -> Result<TaskLease, String> {
        let session = scope(tenant, device, &input.task_id)?;
        let upstream_client = input
            .upstream_client
            .take()
            .ok_or("task upstream must be validated and pinned")?;
        let authority = input
            .authority
            .take()
            .ok_or("task device authority is required")?;
        if !authority() {
            return Err("task device was revoked".into());
        }
        let account = self.account.read();
        if account.generation != expected_generation
            || (account.required && account.owner_account_id.is_none())
        {
            return Err("gateway account changed or is locked".into());
        }
        if input.model.trim().is_empty()
            || input.model.len() > 512
            || !["openai", "anthropic"].contains(&input.provider.protocol.as_str())
            || !["openai-chat", "openai-responses", "anthropic"]
                .contains(&input.ingress_protocol.as_str())
            || !input.provider.enabled
            || input.provider.api_key.as_deref().is_none_or(str::is_empty)
            || !input.provider.api_keys.is_empty()
            || input.provider.rotation_enabled
        {
            return Err("a task must delegate exactly one selected provider credential".into());
        }
        let deployment = format!("task-{}-{}", input.task_id, input.provider.id);
        input.provider.id = deployment.clone();
        input.provider.deployment_id = Some(deployment.clone());
        input.provider.models = vec![input.model.clone()];
        input
            .provider
            .model_metadata
            .retain(|m| m.id == input.model);
        // Replace any live lease for this exact device/task; no sibling device
        // can revoke it, and re-mint cannot retain two spending authorities.
        self.tickets.revoke_session(&session);
        let minted = self
            .tickets
            .mint_owned(
                MintRequest {
                    provider_overrides: vec![input.provider],
                    session_id: session.clone(),
                    parent_session_id: None,
                    execution_fingerprint: session.clone(),
                    candidates: vec![TicketCandidate {
                        deployment_id: deployment,
                        model_id: input.model.clone(),
                    }],
                    model_bindings: [
                        input.model.as_str(),
                        "primary",
                        "fast",
                        "powerful",
                        "sonnet",
                        "haiku",
                        "opus",
                    ]
                    .into_iter()
                    .map(|key| (key.to_owned(), input.model.clone()))
                    .collect::<BTreeMap<_, _>>(),
                    credential_affinity: TicketAffinity::SessionSticky,
                    allow_auth_failover: false,
                    route_policy: "gateway-required".into(),
                    ttl_ms: Some(TASK_LEASE_TTL_MS),
                    model: Some(input.model),
                    operations: Some(vec![
                        if input.ingress_protocol == "openai-responses" {
                            TicketOperation::Responses
                        } else {
                            TicketOperation::Chat
                        },
                        TicketOperation::Models,
                        TicketOperation::CountTokens,
                    ]),
                    budget: None,
                },
                Some(&empty_snapshot()),
                chrono::Utc::now().timestamp_millis(),
                account.owner_account_id.clone(),
            )
            .map_err(|e| e.to_string())?;
        self.tickets
            .set_task_authority(&minted.ticket.ticket_id, authority);
        self.tickets
            .set_task_client(&minted.ticket.ticket_id, upstream_client);
        Ok(TaskLease {
            ticket_id: minted.ticket.ticket_id,
            secret: minted.secret,
            expires_at_ms: minted.ticket.expires_at_ms,
            account_generation: account.generation,
            owner_account_id: account.owner_account_id.clone(),
        })
    }

    pub fn control_task_lease(
        &self,
        tenant: &str,
        device: &str,
        task: &str,
        ticket_id: &str,
        generation: u64,
        renew: bool,
    ) -> Result<bool, String> {
        let session = scope(tenant, device, task)?;
        let account = self.account.read();
        if account.generation != generation
            || (account.required && account.owner_account_id.is_none())
        {
            return Err("gateway account changed".into());
        }
        if !self.tickets.list().iter().any(|t| {
            t.ticket_id == ticket_id
                && t.session_id == session
                && t.owner_account_id == account.owner_account_id
        }) {
            return Err("gateway lease belongs to another task or device".into());
        }
        Ok(if renew {
            self.tickets.renew(
                ticket_id,
                chrono::Utc::now().timestamp_millis(),
                TASK_LEASE_TTL_MS,
            )
        } else {
            self.tickets.revoke(ticket_id)
        })
    }

    /// Desktop tickets use the task session directly, unlike paired-device
    /// delegation. The account generation prevents an unlock/lock/unlock ABA.
    pub fn validate_local_task_secret(
        &self,
        task: &str,
        owner: Option<&str>,
        generation: u64,
        port: u16,
        secret: &str,
    ) -> Result<(), String> {
        if task.is_empty()
            || task.len() > 128
            || !task
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
            || port == 0
        {
            return Err("Invalid local gateway task identity".into());
        }
        let account = self.account.read();
        if account.generation != generation
            || account.owner_account_id.as_deref() != owner
            || (account.required && account.owner_account_id.is_none())
        {
            return Err("Local gateway account authority changed".into());
        }
        let inner = self.inner.lock();
        if !inner.status.running || inner.status.bound_port != Some(port) {
            return Err("Local gateway listener is unavailable or changed".into());
        }
        let now = chrono::Utc::now().timestamp_millis();
        if self.tickets.list().iter().any(|ticket| {
            ticket.session_id == task
                && ticket.owner_account_id == account.owner_account_id
                && self.tickets.is_live(&ticket.ticket_id, now)
                && self
                    .tickets
                    .secret_matches_ticket(&ticket.ticket_id, secret)
        }) {
            Ok(())
        } else {
            Err("Local gateway lease is expired or belongs to another task/account".into())
        }
    }

    pub fn validate_task_secret(
        &self,
        tenant: &str,
        device: &str,
        task: &str,
        secret: &str,
    ) -> Result<(), String> {
        let session = scope(tenant, device, task)?;
        let account = self.account.read();
        let now = chrono::Utc::now().timestamp_millis();
        if self.tickets.list().iter().any(|t| {
            t.session_id == session
                && t.owner_account_id == account.owner_account_id
                && self.tickets.is_live(&t.ticket_id, now)
                && self.tickets.secret_matches_ticket(&t.ticket_id, secret)
        }) {
            Ok(())
        } else {
            Err("gateway lease is expired or belongs to another task/device".into())
        }
    }
}

/// Validate renderer-supplied files, environment and arguments before any
/// trusted sandbox endpoint rewriting. Shared by local and remote spawns.
pub fn validate_task_endpoints(
    env: &std::collections::HashMap<String, String>,
    args: &[String],
    payload: &serde_json::Value,
    endpoint: &str,
) -> Result<(), String> {
    fn check(value: &serde_json::Value, endpoint: &str) -> Result<(), String> {
        match value {
            serde_json::Value::Object(values) => {
                for (key, value) in values {
                    if ["baseURL", "baseUrl", "base_url"].contains(&key.as_str())
                        && value.as_str() != Some(endpoint)
                    {
                        return Err(
                            "gateway task configuration must use this Host's lease endpoint".into(),
                        );
                    }
                    check(value, endpoint)?;
                }
            }
            serde_json::Value::Array(values) => {
                for value in values {
                    check(value, endpoint)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    for (key, expected) in [
        ("OPENAI_BASE_URL", endpoint),
        ("ANTHROPIC_BASE_URL", endpoint.trim_end_matches("/v1")),
    ] {
        if env.get(key).is_some_and(|value| value != expected) {
            return Err("gateway task endpoint belongs to another Host".into());
        }
    }
    for key in [
        "CODEX_CONFIG",
        "COGNIA_DSH_GATEWAY_CONFIG",
        "OPENCODE_CONFIG_CONTENT",
    ] {
        if let Some(raw) = env.get(key) {
            let value: serde_json::Value =
                serde_json::from_str(raw).map_err(|_| "invalid gateway task configuration")?;
            check(&value, endpoint)?;
        }
    }
    if let Some(files) = payload.get("files").and_then(serde_json::Value::as_object) {
        for (name, raw) in files {
            let raw = raw.as_str().ok_or("invalid gateway task file")?;
            let value: serde_json::Value = if name.ends_with(".toml") {
                toml_edit::de::from_str(raw).map_err(|_| "invalid gateway task TOML")?
            } else {
                serde_json::from_str(raw).map_err(|_| "invalid gateway task JSON")?
            };
            check(&value, endpoint)?;
        }
    }
    for (index, argument) in args.iter().enumerate() {
        if argument == "--openai-base-url"
            && args.get(index + 1).map(String::as_str) != Some(endpoint)
        {
            return Err("gateway task argument endpoint belongs to another Host".into());
        }
        if argument.starts_with("model_providers.cognia.base_url") {
            let value: serde_json::Value = toml_edit::de::from_str(argument)
                .map_err(|_| "invalid gateway endpoint override")?;
            check(&value, endpoint)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    fn request() -> TaskLeaseRequest {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let mut value: TaskLeaseRequest = serde_json::from_value(serde_json::json!({
            "taskId": "task-a", "model": "model-a", "ingressProtocol": "openai-chat",
            "provider": {"id":"selected","protocol":"openai","enabled":true,"baseUrl":"https://api.example.com/v1","apiKey":"fake-selected-key"}
        })).unwrap();
        value.upstream_client = Some(reqwest::Client::new());
        value.authority = Some(Arc::new(|| true));
        value
    }
    #[test]
    fn local_task_authority_binds_task_secret_account_generation_and_listener() {
        let state = GatewayState::new();
        state.activate_account("account-a");
        let snapshot:RoutingSnapshot=serde_json::from_value(serde_json::json!({"providers":[{"id":"p","deploymentId":"p","protocol":"openai","baseUrl":"https://example.test/v1","apiKey":"synthetic","enabled":true,"models":["model"]}],"generatedAtMs":1})).unwrap();
        let generation = state.status().account_generation;
        state
            .try_set_account_snapshot(snapshot, Some("account-a"), Some(generation))
            .unwrap();
        let request:MintRequest=serde_json::from_value(serde_json::json!({"sessionId":"local-task","executionFingerprint":"fingerprint","candidates":[],"model":"model","credentialAffinity":"session-sticky","routePolicy":"gateway-required"})).unwrap();
        let ticket = state.mint_route_ticket(request).unwrap();
        state.inner.lock().status.running = true;
        state.inner.lock().status.bound_port = Some(32123);
        assert!(state
            .validate_local_task_secret(
                "local-task",
                Some("account-a"),
                generation,
                32123,
                &ticket.secret
            )
            .is_ok());
        for (task, owner, revision, port, secret) in [
            (
                "another-task",
                Some("account-a"),
                generation,
                32123,
                ticket.secret.as_str(),
            ),
            (
                "local-task",
                Some("account-b"),
                generation,
                32123,
                ticket.secret.as_str(),
            ),
            (
                "local-task",
                None,
                generation,
                32123,
                ticket.secret.as_str(),
            ),
            (
                "local-task",
                Some("account-a"),
                generation + 1,
                32123,
                ticket.secret.as_str(),
            ),
            (
                "local-task",
                Some("account-a"),
                generation,
                32124,
                ticket.secret.as_str(),
            ),
            (
                "local-task",
                Some("account-a"),
                generation,
                32123,
                "wrong-secret",
            ),
        ] {
            assert!(state
                .validate_local_task_secret(task, owner, revision, port, secret)
                .is_err());
        }
        state.inner.lock().status.running = false;
        assert!(state
            .validate_local_task_secret(
                "local-task",
                Some("account-a"),
                generation,
                32123,
                &ticket.secret
            )
            .is_err());
        state.inner.lock().status.running = true;
        state.revoke_route_ticket(&ticket.ticket.ticket_id);
        assert!(state
            .validate_local_task_secret(
                "local-task",
                Some("account-a"),
                generation,
                32123,
                &ticket.secret
            )
            .is_err());
    }
    #[test]
    fn local_task_authority_refuses_account_lock_and_aba_generation() {
        let state = GatewayState::new();
        state.activate_account("account-a");
        let initial = state.status().account_generation;
        state.inner.lock().status.running = true;
        state.inner.lock().status.bound_port = Some(32123);
        state.lock_account();
        assert!(state
            .validate_local_task_secret("task", Some("account-a"), initial, 32123, "secret")
            .unwrap_err()
            .contains("account authority"));
        state.activate_account("account-a");
        assert!(state
            .validate_local_task_secret("task", Some("account-a"), initial, 32123, "secret")
            .unwrap_err()
            .contains("account authority"));
    }
    #[test]
    fn shared_task_endpoint_validation_rejects_foreign_env_files_and_arguments() {
        let endpoint = "http://127.0.0.1:32123/v1";
        let mut env =
            std::collections::HashMap::from([("OPENAI_BASE_URL".into(), endpoint.into())]);
        let payload = serde_json::json!({"files":{"codex/config.toml":format!("[model_providers.cognia]\nbase_url = \"{endpoint}\"")}});
        assert!(validate_task_endpoints(&env, &[], &payload, endpoint).is_ok());
        env.insert("OPENAI_BASE_URL".into(), "http://127.0.0.1:1/v1".into());
        assert!(validate_task_endpoints(&env, &[], &payload, endpoint).is_err());
        env.clear();
        assert!(validate_task_endpoints(
            &env,
            &["--openai-base-url".into(), "http://evil.test/v1".into()],
            &payload,
            endpoint
        )
        .is_err());
        assert!(validate_task_endpoints(
            &env,
            &[],
            &serde_json::json!({"files":{"pi/models.json":"{\"baseUrl\":\"http://evil.test\"}"}}),
            endpoint
        )
        .is_err());
    }
    #[test]
    fn task_credentials_are_private_and_control_is_device_account_scoped() {
        let state = GatewayState::new();
        let generation = state.status().account_generation;
        let lease = state
            .mint_task_lease("tenant", "device-a", generation, request())
            .unwrap();
        assert!(state.with_snapshot(|value| value.is_none()));
        assert_eq!(state.status().snapshot_provider_count, 0);
        assert!(state
            .validate_task_secret("tenant", "device-a", "task-a", &lease.secret)
            .is_ok());
        assert!(state
            .validate_task_secret("tenant", "device-b", "task-a", &lease.secret)
            .is_err());
        assert!(state
            .control_task_lease(
                "tenant",
                "device-b",
                "task-a",
                &lease.ticket_id,
                generation,
                false
            )
            .is_err());
        assert!(state
            .control_task_lease(
                "tenant",
                "device-a",
                "task-a",
                &lease.ticket_id,
                generation,
                true
            )
            .unwrap());
        state.activate_account("different-host-owner");
        assert!(state
            .control_task_lease(
                "tenant",
                "device-a",
                "task-a",
                &lease.ticket_id,
                generation,
                true
            )
            .is_err());
        assert!(state
            .validate_task_secret("tenant", "device-a", "task-a", &lease.secret)
            .is_err());
    }
    #[test]
    fn task_requires_pinned_upstream_and_cannot_change_model_on_resume() {
        let state = GatewayState::new();
        let generation = state.status().account_generation;
        let mut unpinned = request();
        unpinned.upstream_client = None;
        assert!(state
            .mint_task_lease("tenant", "device-a", generation, unpinned)
            .is_err());
        state
            .mint_task_lease("tenant", "device-a", generation, request())
            .unwrap();
        let mut changed = request();
        changed.model = "model-b".into();
        assert!(state
            .mint_task_lease("tenant", "device-a", generation, changed)
            .is_err());
    }
    #[test]
    fn device_revocation_denies_bearer_requests_renewal_and_stream_liveness() {
        let state = GatewayState::new();
        let live = Arc::new(AtomicBool::new(true));
        let mut input = request();
        let check = Arc::clone(&live);
        input.authority = Some(Arc::new(move || check.load(Ordering::SeqCst)));
        let lease = state
            .mint_task_lease(
                "tenant",
                "device-a",
                state.status().account_generation,
                input,
            )
            .unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        assert!(state.tickets.validate(&lease.secret, now).is_ok());
        live.store(false, Ordering::SeqCst);
        assert!(matches!(
            state.tickets.validate(&lease.secret, now),
            Err(TicketReject::Revoked)
        ));
        assert!(!state.tickets.is_live(&lease.ticket_id, now));
        assert!(!state
            .tickets
            .renew(&lease.ticket_id, now, TASK_LEASE_TTL_MS));
    }
    #[tokio::test]
    async fn private_and_ambiguous_upstreams_are_refused_before_mint() {
        for url in [
            "http://public.example/v1",
            "https://127.0.0.1/v1",
            "https://10.0.0.1/v1",
            "https://[::1]/v1",
            "https://service.local/v1",
            "https://user:password@api.example.com/v1",
        ] {
            assert!(validate_public_upstream(url).await.is_err(), "{url}");
        }
    }
    #[tokio::test]
    async fn task_only_listener_uses_private_snapshot_and_rejects_revoked_device() {
        let state = GatewayState::new();
        state.keys.write().clear();
        state.config.write().port = 0;
        let live = Arc::new(AtomicBool::new(true));
        let check = Arc::clone(&live);
        let mut input = request();
        input.authority = Some(Arc::new(move || check.load(Ordering::SeqCst)));
        let lease = state
            .mint_task_lease(
                "tenant",
                "device-a",
                state.status().account_generation,
                input,
            )
            .unwrap();
        let host = Arc::new(crate::host::NoopGatewayHost);
        assert!(state.start(host.clone()).await.is_err());
        state.start_for_task(host, &lease.ticket_id).await.unwrap();
        let endpoint = format!(
            "http://127.0.0.1:{}/v1/models",
            state.status().bound_port.unwrap()
        );
        let client = reqwest::Client::new();
        assert_eq!(client.get(&endpoint).send().await.unwrap().status(), 401);
        let response = client
            .get(&endpoint)
            .bearer_auth(&lease.secret)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        let body: serde_json::Value = response.json().await.unwrap();
        assert!(body["data"]
            .as_array()
            .unwrap()
            .iter()
            .any(|model| model["id"] == "model-a"));
        live.store(false, Ordering::SeqCst);
        assert_eq!(
            client
                .get(&endpoint)
                .bearer_auth(&lease.secret)
                .send()
                .await
                .unwrap()
                .status(),
            401
        );
        state.stop().unwrap();
    }
}
