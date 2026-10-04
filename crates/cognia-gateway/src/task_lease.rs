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

/// The one ticket shape a gateway task runs under, whoever supplied the
/// provider: a single private deployment, one model bound to every selector the
/// agents ask for, no failover, `gateway-required`, and inference/models/
/// count-tokens only.
fn task_mint_request(
    session: String,
    fingerprint: String,
    deployment: String,
    provider: ProviderSnapshot,
    model: String,
    ingress_protocol: &str,
) -> MintRequest {
    MintRequest {
        provider_overrides: vec![provider],
        session_id: session,
        parent_session_id: None,
        execution_fingerprint: fingerprint,
        candidates: vec![TicketCandidate {
            deployment_id: deployment,
            model_id: model.clone(),
        }],
        model_bindings: [
            model.as_str(),
            "primary",
            "fast",
            "powerful",
            "sonnet",
            "haiku",
            "opus",
        ]
        .into_iter()
        .map(|key| (key.to_owned(), model.clone()))
        .collect::<BTreeMap<_, _>>(),
        credential_affinity: TicketAffinity::SessionSticky,
        allow_auth_failover: false,
        route_policy: "gateway-required".into(),
        ttl_ms: Some(TASK_LEASE_TTL_MS),
        model: Some(model),
        operations: Some(vec![
            if ingress_protocol == "openai-responses" {
                TicketOperation::Responses
            } else {
                TicketOperation::Chat
            },
            TicketOperation::Models,
            TicketOperation::CountTokens,
        ]),
        budget: None,
    }
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
        let model = input.model.clone();
        let minted = self
            .tickets
            .mint_owned(
                task_mint_request(
                    session.clone(),
                    session,
                    deployment,
                    input.provider,
                    model,
                    &input.ingress_protocol,
                ),
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

/// A Host-run task (ADR-0090, 2026-10-02 amendment): the Host's own process
/// asks for a lease on a provider the Host already holds. Unlike
/// [`TaskLeaseRequest`] it carries no provider and no credential — both are
/// read from the routing snapshot this gateway already serves (on
/// `cognia-server`, the Provider Profile Store projection), so an upstream key
/// never crosses a process boundary, let alone reaches the paired device the
/// turn runs for.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostTaskLeaseRequest {
    pub task_id: String,
    /// The snapshot provider id (on a headless Host, the profile deployment id).
    pub provider_id: String,
    pub model: String,
    pub ingress_protocol: String,
    /// The paired device the Host runs the turn for. Part of the lease scope,
    /// so one device can neither renew nor reuse another device's task.
    #[serde(default)]
    pub origin_device_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostTaskLease {
    pub ticket_id: String,
    pub secret: String,
    pub account_generation: u64,
    pub owner_account_id: Option<String>,
    pub expires_at_ms: i64,
    /// Capability facts the snapshot carries for the model, when it has any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_metadata: Option<crate::snapshot::ModelMetadata>,
}

fn host_scope(origin: Option<&str>, task: &str) -> Result<String, String> {
    let origin = origin.unwrap_or("");
    if task.is_empty()
        || task.len() > 128
        || !task
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        || origin.len() > 256
    {
        return Err("invalid gateway task identity".into());
    }
    Ok(serde_json::to_string(&("host-task", origin, task)).expect("strings serialize"))
}

impl GatewayState {
    /// Mint a renewable, task-private lease on one Host provider and model.
    ///
    /// The provider is copied out of the CURRENT snapshot into a private
    /// deployment the ticket alone can reach, with exactly one credential, so a
    /// later snapshot change cannot widen the task and the task cannot reach
    /// any other provider. The ticket shape is the device lease's
    /// ([`task_mint_request`]): `gateway-required`, session-sticky, no
    /// failover, inference/models/count-tokens only, two-minute TTL.
    pub fn mint_host_task_lease(
        &self,
        expected_generation: u64,
        input: HostTaskLeaseRequest,
        authority: Option<std::sync::Arc<dyn Fn() -> bool + Send + Sync>>,
    ) -> Result<HostTaskLease, String> {
        let session = host_scope(input.origin_device_id.as_deref(), &input.task_id)?;
        if authority.as_ref().is_some_and(|check| !check()) {
            return Err("task device was revoked".into());
        }
        if input.model.trim().is_empty()
            || input.model.len() > 512
            || input.provider_id.trim().is_empty()
            || !["openai-chat", "openai-responses", "anthropic"]
                .contains(&input.ingress_protocol.as_str())
        {
            return Err("invalid gateway task request".into());
        }
        let account = self.account.read();
        if account.generation != expected_generation
            || (account.required && account.owner_account_id.is_none())
        {
            return Err("gateway account changed or is locked".into());
        }
        let mut provider = self
            .with_snapshot(|snapshot| {
                snapshot
                    .and_then(|snapshot| {
                        snapshot
                            .provider(&input.provider_id)
                            .or_else(|| snapshot.provider_by_deployment(&input.provider_id))
                    })
                    .cloned()
            })
            .ok_or("the selected provider is not configured on this Host")?;
        if !["openai", "anthropic"].contains(&provider.protocol.as_str()) {
            return Err("the selected provider protocol cannot serve a gateway task".into());
        }
        if !provider.models.iter().any(|model| model == &input.model) {
            return Err("the selected model is not configured for this provider".into());
        }
        let credential = provider
            .api_key
            .clone()
            .filter(|key| !key.is_empty())
            .or_else(|| {
                provider
                    .api_keys
                    .iter()
                    .find(|key| !key.is_empty())
                    .cloned()
            })
            .ok_or("the selected provider has no usable credential on this Host")?;
        let deployment = format!("host-task-{}", input.task_id);
        provider.id = deployment.clone();
        provider.deployment_id = Some(deployment.clone());
        provider.api_key = Some(credential);
        provider.api_keys = Vec::new();
        provider.rotation_enabled = false;
        provider.rotation_strategy = None;
        provider.models = vec![input.model.clone()];
        provider.model_metadata.retain(|m| m.id == input.model);
        let model_metadata = provider.model_metadata.first().cloned();
        // One live lease per task: a rebind or retry replaces the previous one.
        self.tickets.revoke_session(&session);
        let minted = self
            .tickets
            .mint_owned(
                task_mint_request(
                    session,
                    // Unique per mint, so an in-task rebind to another model is
                    // a new frozen spec rather than a widened re-mint.
                    format!("host-task:{}", uuid::Uuid::new_v4().simple()),
                    deployment,
                    provider,
                    input.model,
                    &input.ingress_protocol,
                ),
                Some(&empty_snapshot()),
                chrono::Utc::now().timestamp_millis(),
                account.owner_account_id.clone(),
            )
            .map_err(|e| e.to_string())?;
        if let Some(authority) = authority {
            self.tickets
                .set_task_authority(&minted.ticket.ticket_id, authority);
        }
        Ok(HostTaskLease {
            ticket_id: minted.ticket.ticket_id,
            secret: minted.secret,
            expires_at_ms: minted.ticket.expires_at_ms,
            account_generation: account.generation,
            owner_account_id: account.owner_account_id.clone(),
            model_metadata,
        })
    }

    /// Renew (`true`) or revoke (`false`) a Host task lease. Scoped to the
    /// task, its origin device and the account generation it was minted under.
    pub fn control_host_task_lease(
        &self,
        origin: Option<&str>,
        task: &str,
        ticket_id: &str,
        generation: u64,
        renew: bool,
    ) -> Result<bool, String> {
        let session = host_scope(origin, task)?;
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

    /// The launch-time check for a Host task: the secret the process is about
    /// to receive belongs to a live lease for exactly this task and device.
    pub fn validate_host_task_secret(
        &self,
        origin: Option<&str>,
        task: &str,
        secret: &str,
    ) -> Result<(), String> {
        let session = host_scope(origin, task)?;
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
        // Kimi Code's env model, Copilot BYOK and Goose's OpenAI host.
        ("KIMI_MODEL_BASE_URL", endpoint),
        ("COPILOT_PROVIDER_BASE_URL", endpoint),
        ("OPENAI_HOST", endpoint.trim_end_matches("/v1")),
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
        // Qwen's `--openai-base-url`, Aider's `--openai-api-base`.
        if (argument == "--openai-base-url" || argument == "--openai-api-base")
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
        assert!(validate_task_endpoints(
            &env,
            &["--openai-api-base".into(), endpoint.into()],
            &payload,
            endpoint
        )
        .is_ok());
        assert!(validate_task_endpoints(
            &env,
            &["--openai-api-base".into(), "http://evil.test/v1".into()],
            &payload,
            endpoint
        )
        .is_err());
        for (key, own) in [
            ("KIMI_MODEL_BASE_URL", endpoint),
            ("COPILOT_PROVIDER_BASE_URL", endpoint),
            ("OPENAI_HOST", "http://127.0.0.1:32123"),
        ] {
            let mut env = std::collections::HashMap::from([(key.to_string(), own.to_string())]);
            assert!(
                validate_task_endpoints(&env, &[], &payload, endpoint).is_ok(),
                "{key}"
            );
            env.insert(key.into(), "http://evil.test/v1".into());
            assert!(
                validate_task_endpoints(&env, &[], &payload, endpoint).is_err(),
                "{key}"
            );
        }
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
    fn host_state(base_url: &str) -> GatewayState {
        let state = GatewayState::new();
        state.set_snapshot(
            serde_json::from_value(serde_json::json!({
                "providers": [
                    {"id":"host-openai","deploymentId":"host-openai","protocol":"openai","baseUrl":base_url,
                     "apiKey":"host-only-key","enabled":true,"models":["model-a","model-b"],
                     "modelMetadata":[{"id":"model-a","contextLength":64000,"supportsTools":true}]},
                    {"id":"keyless","protocol":"openai","baseUrl":base_url,"enabled":true,"models":["model-a"]},
                    {"id":"gemini","protocol":"gemini","baseUrl":base_url,"apiKey":"k","enabled":true,"models":["model-a"]},
                    {"id":"disabled","protocol":"openai","baseUrl":base_url,"apiKey":"k","enabled":false,"models":["model-a"]}
                ],
                "generatedAtMs": 1
            }))
            .unwrap(),
        );
        state
    }
    fn host_request(task: &str, origin: Option<&str>) -> HostTaskLeaseRequest {
        serde_json::from_value(serde_json::json!({
            "taskId": task, "providerId": "host-openai", "model": "model-a",
            "ingressProtocol": "openai-chat", "originDeviceId": origin,
        }))
        .unwrap()
    }
    #[test]
    fn host_task_lease_copies_one_host_provider_into_a_private_scoped_ticket() {
        let state = host_state("https://api.example.com/v1");
        let generation = state.status().account_generation;
        let lease = state
            .mint_host_task_lease(generation, host_request("task-a", Some("phone-a")), None)
            .unwrap();
        // The shared snapshot is untouched; the task deployment is ticket-private.
        assert!(state.with_snapshot(|snapshot| snapshot
            .unwrap()
            .providers
            .iter()
            .all(|provider| !provider.id.starts_with("host-task-"))));
        let ticket = state
            .list_route_tickets()
            .into_iter()
            .find(|ticket| ticket.ticket_id == lease.ticket_id)
            .unwrap();
        assert_eq!(ticket.route_policy, "gateway-required");
        assert!(!ticket.allow_auth_failover);
        assert_eq!(
            ticket.candidates,
            vec![TicketCandidate {
                deployment_id: "host-task-task-a".into(),
                model_id: "model-a".into()
            }]
        );
        assert_eq!(
            ticket.operations,
            vec![
                TicketOperation::Chat,
                TicketOperation::Models,
                TicketOperation::CountTokens
            ]
        );
        assert!(ticket
            .model_bindings
            .values()
            .all(|model| model == "model-a"));
        assert!(lease.expires_at_ms - chrono::Utc::now().timestamp_millis() <= TASK_LEASE_TTL_MS);
        assert_eq!(
            lease.model_metadata.as_ref().unwrap().fields["contextLength"],
            64000
        );
        // The wire shape never names the credential.
        let wire = serde_json::to_string(&lease).unwrap();
        assert!(!wire.contains("host-only-key"));

        assert!(state
            .validate_host_task_secret(Some("phone-a"), "task-a", &lease.secret)
            .is_ok());
        for (origin, task, secret) in [
            (Some("phone-b"), "task-a", lease.secret.as_str()),
            (None, "task-a", lease.secret.as_str()),
            (Some("phone-a"), "task-b", lease.secret.as_str()),
            (Some("phone-a"), "task-a", "sk-cognia-rt-wrong"),
        ] {
            assert!(state
                .validate_host_task_secret(origin, task, secret)
                .is_err());
        }
        assert!(state
            .control_host_task_lease(
                Some("phone-b"),
                "task-a",
                &lease.ticket_id,
                generation,
                true
            )
            .is_err());
        assert!(state
            .control_host_task_lease(
                Some("phone-a"),
                "task-a",
                &lease.ticket_id,
                generation + 1,
                true
            )
            .is_err());
        assert!(state
            .control_host_task_lease(
                Some("phone-a"),
                "task-a",
                &lease.ticket_id,
                generation,
                true
            )
            .unwrap());
        assert!(state
            .control_host_task_lease(
                Some("phone-a"),
                "task-a",
                &lease.ticket_id,
                generation,
                false
            )
            .unwrap());
        assert!(state
            .validate_host_task_secret(Some("phone-a"), "task-a", &lease.secret)
            .is_err());
    }
    #[test]
    fn host_task_lease_refuses_what_the_host_cannot_serve() {
        let state = host_state("https://api.example.com/v1");
        let generation = state.status().account_generation;
        let mint = |provider: &str, model: &str, ingress: &str| {
            state.mint_host_task_lease(
                generation,
                serde_json::from_value(serde_json::json!({
                    "taskId": "task", "providerId": provider, "model": model,
                    "ingressProtocol": ingress,
                }))
                .unwrap(),
                None,
            )
        };
        assert!(mint("host-openai", "model-a", "openai-chat").is_ok());
        assert!(mint("host-openai", "model-b", "openai-responses").is_ok());
        for (provider, model, ingress) in [
            ("missing", "model-a", "openai-chat"),
            ("host-openai", "model-z", "openai-chat"),
            ("keyless", "model-a", "openai-chat"),
            ("gemini", "model-a", "openai-chat"),
            ("disabled", "model-a", "openai-chat"),
            ("host-openai", "model-a", "gemini"),
            ("host-openai", " ", "openai-chat"),
        ] {
            assert!(
                mint(provider, model, ingress).is_err(),
                "{provider} {model} {ingress}"
            );
        }
        // A caller cannot smuggle a provider or a credential in.
        assert!(
            serde_json::from_value::<HostTaskLeaseRequest>(serde_json::json!({
                "taskId": "task", "providerId": "host-openai", "model": "model-a",
                "ingressProtocol": "openai-chat", "provider": {"apiKey": "x"}
            }))
            .is_err()
        );
        assert!(state
            .mint_host_task_lease(generation + 1, host_request("task", None), None)
            .is_err());
        assert!(state
            .mint_host_task_lease(generation, host_request("../task", None), None)
            .is_err());
        assert!(state
            .mint_host_task_lease(
                generation,
                host_request("task", None),
                Some(Arc::new(|| false))
            )
            .is_err());
    }
    #[test]
    fn a_host_task_holds_one_live_lease_and_follows_device_revocation() {
        let state = host_state("https://api.example.com/v1");
        let generation = state.status().account_generation;
        let first = state
            .mint_host_task_lease(generation, host_request("task", Some("phone")), None)
            .unwrap();
        let live = Arc::new(AtomicBool::new(true));
        let check = Arc::clone(&live);
        let second = state
            .mint_host_task_lease(
                generation,
                host_request("task", Some("phone")),
                Some(Arc::new(move || check.load(Ordering::SeqCst))),
            )
            .unwrap();
        assert!(state
            .validate_host_task_secret(Some("phone"), "task", &first.secret)
            .is_err());
        assert!(state
            .validate_host_task_secret(Some("phone"), "task", &second.secret)
            .is_ok());
        live.store(false, Ordering::SeqCst);
        assert!(state
            .validate_host_task_secret(Some("phone"), "task", &second.secret)
            .is_err());
    }
    /// The whole Host path over real sockets: a stub upstream, the task-only
    /// listener, and a request carrying nothing but the lease secret.
    #[tokio::test]
    async fn host_task_lease_reaches_the_host_provider_through_the_task_listener() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let seen = Arc::new(parking_lot::Mutex::new(
            Vec::<(String, serde_json::Value)>::new(),
        ));
        let record = Arc::clone(&seen);
        let upstream = axum::Router::new().route(
            "/v1/chat/completions",
            axum::routing::post(
                move |headers: axum::http::HeaderMap,
                      axum::Json(body): axum::Json<serde_json::Value>| {
                    let record = Arc::clone(&record);
                    async move {
                        record.lock().push((
                            headers
                                .get("authorization")
                                .and_then(|value| value.to_str().ok())
                                .unwrap_or_default()
                                .to_string(),
                            body,
                        ));
                        axum::Json(serde_json::json!({
                            "id": "chatcmpl-stub", "object": "chat.completion", "created": 1,
                            "model": "model-a",
                            "choices": [{"index": 0, "finish_reason": "stop",
                                "message": {"role": "assistant", "content": "stub reply"}}],
                            "usage": {"prompt_tokens": 1, "completion_tokens": 2, "total_tokens": 3}
                        }))
                    }
                },
            ),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, upstream).await;
        });
        let state = host_state(&format!("http://{upstream_addr}/v1"));
        state.keys.write().clear();
        state.config.write().port = 0;
        let lease = state
            .mint_host_task_lease(
                state.status().account_generation,
                host_request("task-e2e", Some("phone")),
                None,
            )
            .unwrap();
        let host = Arc::new(crate::host::NoopGatewayHost);
        state.start_for_task(host, &lease.ticket_id).await.unwrap();
        let base = format!("http://127.0.0.1:{}/v1", state.status().bound_port.unwrap());
        let client = reqwest::Client::new();
        let reply: serde_json::Value = client
            .post(format!("{base}/chat/completions"))
            .bearer_auth(&lease.secret)
            .json(&serde_json::json!({
                "model": "model-a",
                "messages": [{"role": "user", "content": "hi"}]
            }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(reply["choices"][0]["message"]["content"], "stub reply");
        {
            let seen = seen.lock();
            assert_eq!(seen.len(), 1);
            assert_eq!(seen[0].0, "Bearer host-only-key");
            assert_eq!(seen[0].1["model"], "model-a");
        }
        // Embeddings are outside the ticket's operations.
        assert_ne!(
            client
                .post(format!("{base}/embeddings"))
                .bearer_auth(&lease.secret)
                .json(&serde_json::json!({"model": "model-a", "input": "x"}))
                .send()
                .await
                .unwrap()
                .status(),
            200
        );
        state.stop().unwrap();
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
