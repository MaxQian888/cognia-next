use std::collections::{HashMap, HashSet};

use axum::http::StatusCode;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::{
    command_manifest::{
        CommandApproval, CommandDescriptor, CommandIdempotency, CommandTarget, CommandTransport,
    },
    middleware::DeviceContext,
    security_store::{security_store, IdempotencyDecision, SecurityStoreError},
    SharedState,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExecutionTransport {
    Http,
    WebSocket,
    WebRtc,
    Internal,
}

impl ExecutionTransport {
    fn manifest_transport(self) -> CommandTransport {
        match self {
            Self::Http => CommandTransport::Http,
            Self::WebSocket => CommandTransport::Websocket,
            Self::WebRtc => CommandTransport::Webrtc,
            Self::Internal => CommandTransport::Internal,
        }
    }
}

#[derive(Clone, Debug)]
pub struct ExecutionRequest {
    pub command: String,
    pub args: Value,
    pub principal: DeviceContext,
    pub transport: ExecutionTransport,
    pub request_id: String,
    pub policy_id: Option<String>,
    pub idempotency_key: Option<String>,
}

impl ExecutionRequest {
    pub fn new(
        command: impl Into<String>,
        args: Value,
        principal: DeviceContext,
        transport: ExecutionTransport,
        idempotency_key: Option<String>,
    ) -> Self {
        let policy_id = args
            .get("policyId")
            .or_else(|| args.get("policy_id"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        Self {
            command: command.into(),
            args,
            principal,
            transport,
            request_id: Uuid::new_v4().to_string(),
            policy_id,
            idempotency_key,
        }
    }
}

/// Derive a stable UUID from an authenticated protocol request identifier.
/// Adapters use this for durable idempotency when their wire protocol does not
/// require UUID request ids. Tenant and device attribution prevent two callers
/// that reuse the same JSON-RPC id from sharing a ledger entry.
pub(crate) fn derive_protocol_request_uuid(
    principal: &DeviceContext,
    protocol: &str,
    wire_request_id: &Value,
    purpose: &str,
) -> String {
    let wire_request_id = serde_json::to_vec(wire_request_id).unwrap_or_default();
    let mut hasher = Sha256::new();
    for part in [
        principal.account_id.as_bytes(),
        principal.device_id.as_bytes(),
        protocol.as_bytes(),
        purpose.as_bytes(),
        wire_request_id.as_slice(),
    ] {
        hasher.update((part.len() as u64).to_be_bytes());
        hasher.update(part);
    }
    let digest = hasher.finalize();
    let mut bytes = [0_u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    // Stamp RFC 9562 variant and a name-based version so diagnostics identify
    // these as deterministic ids rather than random client-generated UUIDs.
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes).to_string()
}

pub(crate) fn protocol_idempotency_key(
    command: &str,
    principal: &DeviceContext,
    protocol: &str,
    wire_request_id: Option<&Value>,
) -> Option<String> {
    super::command_manifest::descriptor(command)
        .filter(|descriptor| descriptor.idempotency == CommandIdempotency::Required)
        .map(|_| {
            wire_request_id.map_or_else(
                || Uuid::new_v4().to_string(),
                |request_id| derive_protocol_request_uuid(principal, protocol, request_id, command),
            )
        })
}

#[derive(Clone, Debug, PartialEq)]
pub enum ExecutionOutcome {
    Completed {
        request_id: String,
        operation_id: Option<String>,
        result: Value,
        replayed: bool,
    },
    Accepted {
        request_id: String,
        operation_id: String,
    },
}

#[derive(Clone, Debug)]
pub struct ExecutionError {
    pub status: StatusCode,
    pub code: String,
    pub message: String,
    pub request_id: String,
    pub retryable: bool,
    pub details: Value,
    pub operation_id: Option<String>,
}

impl ExecutionError {
    fn new(
        request_id: &str,
        status: StatusCode,
        code: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            status,
            code: code.into(),
            message: message.into(),
            request_id: request_id.to_string(),
            retryable: status.is_server_error(),
            details: json!({}),
            operation_id: None,
        }
    }

    fn with_operation_id(mut self, operation_id: String) -> Self {
        self.operation_id = Some(operation_id);
        self
    }
}

/// The single remote command authority. Wire adapters authenticate their
/// protocol, construct an `ExecutionRequest`, and delegate all governance and
/// dispatch behavior here.
pub async fn execute(
    state: &SharedState,
    request: ExecutionRequest,
) -> Result<ExecutionOutcome, ExecutionError> {
    let descriptor = super::command_manifest::descriptor(&request.command).ok_or_else(|| {
        ExecutionError::new(
            &request.request_id,
            StatusCode::NOT_FOUND,
            "unknown_command",
            "the requested command is not registered",
        )
    })?;
    authorize_transport(&request, descriptor)?;
    authorize_capability(&request, descriptor)?;
    authorize_approval(&request, descriptor)?;

    if request.principal.scope != "service" {
        if let super::rate_limit::RateLimitDecision::Reject { retry_after } =
            state.rate_limiter.check(&request.principal.device_id)
        {
            let mut error = ExecutionError::new(
                &request.request_id,
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limited",
                "device exceeded the remote execution quota",
            );
            error.details = json!({ "retryAfterSeconds": retry_after.as_secs() });
            return Err(error);
        }
    }

    if descriptor.idempotency != CommandIdempotency::Required {
        let result = dispatch(state, &request).await?;
        return Ok(ExecutionOutcome::Completed {
            request_id: request.request_id,
            operation_id: None,
            result,
            replayed: false,
        });
    }

    let idempotency_key = request.idempotency_key.as_deref().ok_or_else(|| {
        ExecutionError::new(
            &request.request_id,
            StatusCode::BAD_REQUEST,
            "idempotency_key_required",
            "a UUID Idempotency-Key is required for this command",
        )
    })?;
    if Uuid::parse_str(idempotency_key).is_err() {
        return Err(ExecutionError::new(
            &request.request_id,
            StatusCode::BAD_REQUEST,
            "idempotency_key_required",
            "a UUID Idempotency-Key is required for this command",
        ));
    }

    let store = security_store().ok_or_else(|| store_unavailable(&request.request_id))?;
    let payload = serde_json::to_vec(&json!({
        "command": request.command,
        "args": request.args,
    }))
    .unwrap_or_default();
    let request_hash = hex::encode(Sha256::digest(payload));
    let now = unix_time_secs();
    let operation_id = match store
        .begin_idempotent_operation(
            &request.principal.account_id,
            &request.principal.device_id,
            &local_host_id(),
            idempotency_key,
            &request_hash,
            now,
        )
        .map_err(|error| map_store_error(&request.request_id, error))?
    {
        IdempotencyDecision::InProgress { operation_id } => {
            return Ok(ExecutionOutcome::Accepted {
                request_id: request.request_id,
                operation_id,
            });
        }
        IdempotencyDecision::Completed {
            operation_id,
            receipt_json,
        } => return replay_receipt(&request.request_id, operation_id, &receipt_json),
        IdempotencyDecision::Started { operation_id } => operation_id,
    };
    store
        .mark_operation_running(&request.principal.account_id, &operation_id, now)
        .map_err(|error| map_store_error(&request.request_id, error))?;

    match dispatch(state, &request).await {
        Ok(result) => {
            let receipt = json!({ "httpStatus": 200, "result": result });
            store
                .complete_idempotent_operation(
                    &request.principal.account_id,
                    &request.principal.device_id,
                    idempotency_key,
                    &receipt.to_string(),
                    true,
                    unix_time_secs(),
                )
                .map_err(|error| map_store_error(&request.request_id, error))?;
            Ok(ExecutionOutcome::Completed {
                request_id: request.request_id,
                operation_id: Some(operation_id),
                result,
                replayed: false,
            })
        }
        Err(mut error) => {
            let receipt = json!({
                "httpStatus": error.status.as_u16(),
                "error": {
                    "code": error.code,
                    "message": error.message,
                    "retryable": error.retryable,
                    "details": error.details,
                }
            });
            store
                .complete_idempotent_operation(
                    &request.principal.account_id,
                    &request.principal.device_id,
                    idempotency_key,
                    &receipt.to_string(),
                    false,
                    unix_time_secs(),
                )
                .map_err(|store_error| map_store_error(&request.request_id, store_error))?;
            error.operation_id = Some(operation_id);
            Err(error)
        }
    }
}

fn authorize_transport(
    request: &ExecutionRequest,
    descriptor: &CommandDescriptor,
) -> Result<(), ExecutionError> {
    let service_principal = request.principal.scope == "service";
    let allowed = if request.transport == ExecutionTransport::Internal {
        service_principal
    } else {
        !service_principal
            && matches!(
                descriptor.target,
                CommandTarget::Execution | CommandTarget::HostAdmin
            )
            && descriptor
                .transports
                .contains(&request.transport.manifest_transport())
    };
    if !allowed {
        return Err(ExecutionError::new(
            &request.request_id,
            StatusCode::FORBIDDEN,
            "command_transport_forbidden",
            "the command cannot run through this principal and transport",
        ));
    }
    Ok(())
}

fn authorize_capability(
    request: &ExecutionRequest,
    descriptor: &CommandDescriptor,
) -> Result<(), ExecutionError> {
    if request.principal.scope == "service" {
        return Ok(());
    }
    let granted = match snapshot_capability_decision(&request.principal, &descriptor.capability) {
        Some(granted) => granted,
        None => security_store()
            .ok_or_else(|| store_unavailable(&request.request_id))?
            .has_capability(
                &request.principal.account_id,
                &request.principal.device_id,
                &descriptor.capability,
            )
            .map_err(|error| map_store_error(&request.request_id, error))?,
    };
    if !granted {
        return Err(ExecutionError::new(
            &request.request_id,
            StatusCode::FORBIDDEN,
            "missing_capability",
            "the device is not authorized for this command",
        ));
    }
    Ok(())
}

fn snapshot_capability_decision(principal: &DeviceContext, capability: &str) -> Option<bool> {
    principal
        .authorization_capabilities
        .as_ref()
        .map(|capabilities| capabilities.iter().any(|granted| granted == capability))
}

fn authorize_approval(
    request: &ExecutionRequest,
    descriptor: &CommandDescriptor,
) -> Result<(), ExecutionError> {
    // The loopback-only service principal is the policy authority for the
    // internal Brain plane. Device transports must still present interactive
    // leases or signed host policies according to the manifest.
    if request.principal.scope == "service" && request.transport == ExecutionTransport::Internal {
        return Ok(());
    }
    match descriptor.approval {
        CommandApproval::None => Ok(()),
        CommandApproval::Interactive if request.command == "host_admin_lease_issue" => {
            if request.args.get("confirmed").and_then(Value::as_bool) == Some(true) {
                Ok(())
            } else {
                Err(ExecutionError::new(
                    &request.request_id,
                    StatusCode::PRECONDITION_REQUIRED,
                    "interactive_approval_required",
                    "explicit host confirmation is required",
                ))
            }
        }
        CommandApproval::Interactive => {
            let lease = request
                .args
                .get("adminLease")
                .or_else(|| request.args.get("admin_lease"))
                .and_then(Value::as_str);
            super::admin_lease::validate(&request.principal.device_id, &request.command, lease)
                .map_err(|_| {
                    ExecutionError::new(
                        &request.request_id,
                        StatusCode::PRECONDITION_REQUIRED,
                        "interactive_approval_required",
                        "a current device-bound approval lease is required",
                    )
                })
        }
        CommandApproval::SignedPolicy => {
            let policy_id = request.policy_id.as_deref().ok_or_else(|| {
                ExecutionError::new(
                    &request.request_id,
                    StatusCode::PRECONDITION_REQUIRED,
                    "signed_policy_required",
                    "an active host policy is required",
                )
            })?;
            let policy = security_store()
                .ok_or_else(|| store_unavailable(&request.request_id))?
                .authorize_host_policy(
                    &request.principal.account_id,
                    policy_id,
                    &descriptor.capability,
                    &request.command,
                    unix_time_secs(),
                )
                .map_err(|error| map_store_error(&request.request_id, error))?;
            if json_subset_matches(
                policy.get("constraints").unwrap_or(&Value::Null),
                &request.args,
            ) {
                Ok(())
            } else {
                Err(ExecutionError::new(
                    &request.request_id,
                    StatusCode::FORBIDDEN,
                    "policy_constraints_mismatch",
                    "the request exceeds the active host policy",
                ))
            }
        }
    }
}

async fn dispatch(
    state: &SharedState,
    request: &ExecutionRequest,
) -> Result<Value, ExecutionError> {
    super::rpc::dispatch_canonical(
        &request.command,
        request.args.clone(),
        state,
        &request.principal,
    )
    .await
    .map_err(|(status, axum::Json(error))| {
        ExecutionError::new(&request.request_id, status, error.code, error.message)
    })
}

fn replay_receipt(
    request_id: &str,
    operation_id: String,
    receipt_json: &str,
) -> Result<ExecutionOutcome, ExecutionError> {
    let receipt: Value = serde_json::from_str(receipt_json).unwrap_or_else(|_| json!({}));
    if let Some(result) = receipt.get("result").cloned().or_else(|| {
        receipt
            .get("body")
            .cloned()
            .filter(|body| body.get("error").is_none())
    }) {
        return Ok(ExecutionOutcome::Completed {
            request_id: request_id.to_string(),
            operation_id: Some(operation_id),
            result,
            replayed: true,
        });
    }
    let status = receipt
        .get("httpStatus")
        .and_then(Value::as_u64)
        .and_then(|value| u16::try_from(value).ok())
        .and_then(|value| StatusCode::from_u16(value).ok())
        .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let detail = receipt
        .get("error")
        .or_else(|| receipt.get("body").and_then(|body| body.get("error")));
    let mut error = ExecutionError::new(
        request_id,
        status,
        detail
            .and_then(|value| value.get("code"))
            .and_then(Value::as_str)
            .unwrap_or("operation_failed"),
        detail
            .and_then(|value| value.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("the prior operation failed"),
    )
    .with_operation_id(operation_id);
    error.retryable = detail
        .and_then(|value| value.get("retryable"))
        .and_then(Value::as_bool)
        .unwrap_or_else(|| status.is_server_error());
    Err(error)
}

pub(super) fn json_subset_matches(expected: &Value, actual: &Value) -> bool {
    fn matches(expected: &Value, actual: &Value, depth: usize) -> bool {
        match (expected, actual) {
            (Value::Object(expected), Value::Object(actual)) => {
                (depth == 0 || expected.len() == actual.len())
                    && expected.iter().all(|(key, value)| {
                        actual
                            .get(key)
                            .is_some_and(|actual| matches(value, actual, depth + 1))
                    })
            }
            _ => expected == actual,
        }
    }
    matches(expected, actual, 0)
}

fn map_store_error(request_id: &str, error: SecurityStoreError) -> ExecutionError {
    match error {
        SecurityStoreError::IdempotencyConflict => ExecutionError::new(
            request_id,
            StatusCode::CONFLICT,
            "idempotency_conflict",
            "the idempotency key was already used with different parameters",
        ),
        SecurityStoreError::InvalidPolicy => ExecutionError::new(
            request_id,
            StatusCode::FORBIDDEN,
            "invalid_policy",
            "the host policy is invalid, inactive, or does not cover this command",
        ),
        _ => store_unavailable(request_id),
    }
}

fn store_unavailable(request_id: &str) -> ExecutionError {
    ExecutionError::new(
        request_id,
        StatusCode::SERVICE_UNAVAILABLE,
        "security_store_unavailable",
        "the security database could not complete the request",
    )
}

fn unix_time_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn local_host_id() -> String {
    std::env::var("COGNIA_HOST_ID")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "local-host".to_string())
}

const CONTEXT_TTL_MS: u64 = 30 * 60 * 1000;

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteExecutionContext {
    pub host_id: String,
    pub origin_device_id: String,
    pub session_id: String,
    pub generation: u64,
    pub request_id: String,
    pub issued_at: u64,
    pub expires_at: u64,
}

#[derive(Debug, Default)]
struct RegistryState {
    latest: HashMap<String, RemoteExecutionContext>,
    pending: HashSet<String>,
    consumed: HashSet<String>,
}

#[derive(Debug, Default)]
pub struct RemoteExecutionRegistry {
    state: Mutex<RegistryState>,
}

impl RemoteExecutionRegistry {
    pub fn register(
        &self,
        host_id: &str,
        origin_device_id: &str,
        session_id: &str,
        now_ms: u64,
    ) -> RemoteExecutionContext {
        let mut state = self.state.lock();
        let generation = state
            .latest
            .get(session_id)
            .map_or(1, |context| context.generation.saturating_add(1));
        let context = RemoteExecutionContext {
            host_id: host_id.to_string(),
            origin_device_id: origin_device_id.to_string(),
            session_id: session_id.to_string(),
            generation,
            request_id: Uuid::new_v4().to_string(),
            issued_at: now_ms,
            expires_at: now_ms.saturating_add(CONTEXT_TTL_MS),
        };
        state.latest.insert(session_id.to_string(), context.clone());
        state
            .consumed
            .retain(|key| !key.starts_with(&format!("{session_id}:")));
        state
            .pending
            .retain(|key| !key.starts_with(&format!("{session_id}:")));
        context
    }

    pub fn register_pending(
        &self,
        context: &RemoteExecutionContext,
        response_id: &str,
    ) -> Result<(), &'static str> {
        if response_id.is_empty() {
            return Err("REMOTE_RESPONSE_STALE");
        }
        let mut state = self.state.lock();
        let Some(latest) = state.latest.get(&context.session_id) else {
            return Err("REMOTE_RESPONSE_STALE");
        };
        if latest != context {
            return Err("REMOTE_RESPONSE_STALE");
        }
        state.pending.insert(pending_key(context, response_id));
        Ok(())
    }

    pub fn validate(
        &self,
        context: &RemoteExecutionContext,
        caller_device_id: &str,
        session_id: &str,
        now_ms: u64,
    ) -> Result<(), &'static str> {
        let state = self.state.lock();
        validate_locked(&state, context, caller_device_id, session_id, now_ms)
    }

    pub fn validate_and_consume(
        &self,
        context: &RemoteExecutionContext,
        caller_device_id: &str,
        session_id: &str,
        response_id: &str,
        now_ms: u64,
    ) -> Result<(), &'static str> {
        let mut state = self.state.lock();
        validate_locked(&state, context, caller_device_id, session_id, now_ms)?;
        let key = pending_key(context, response_id);
        if !state.pending.remove(&key) || !state.consumed.insert(key) {
            return Err("REMOTE_RESPONSE_STALE");
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn validate_pending_message(
        &self,
        context: &RemoteExecutionContext,
        caller_device_id: &str,
        session_id: &str,
        pending_id: &str,
        message_id: &str,
        terminal: bool,
        now_ms: u64,
    ) -> Result<(), &'static str> {
        let mut state = self.state.lock();
        validate_locked(&state, context, caller_device_id, session_id, now_ms)?;
        let pending_key = pending_key(context, pending_id);
        if !state.pending.contains(&pending_key) {
            return Err("REMOTE_RESPONSE_STALE");
        }
        let message_key = format!("{pending_key}:message:{message_id}");
        if !state.consumed.insert(message_key) {
            return Err("REMOTE_RESPONSE_STALE");
        }
        if terminal {
            state.pending.remove(&pending_key);
        }
        Ok(())
    }
}

fn pending_key(context: &RemoteExecutionContext, response_id: &str) -> String {
    format!(
        "{}:{}:{response_id}",
        context.session_id, context.request_id
    )
}

fn validate_locked(
    state: &RegistryState,
    context: &RemoteExecutionContext,
    caller_device_id: &str,
    session_id: &str,
    now_ms: u64,
) -> Result<(), &'static str> {
    if context.origin_device_id != caller_device_id || context.session_id != session_id {
        return Err("REMOTE_SCOPE_DENIED");
    }
    if context.expires_at < now_ms {
        return Err("REMOTE_PROXY_DISCONNECTED");
    }
    let Some(latest) = state.latest.get(session_id) else {
        return Err("REMOTE_RESPONSE_STALE");
    };
    if latest != context {
        return Err("REMOTE_RESPONSE_STALE");
    }
    Ok(())
}

static REGISTRY: once_cell::sync::Lazy<RemoteExecutionRegistry> =
    once_cell::sync::Lazy::new(RemoteExecutionRegistry::default);

pub fn global() -> &'static RemoteExecutionRegistry {
    &REGISTRY
}

#[cfg(test)]
mod tests {
    use super::*;

    fn execution_request(scope: &str, capabilities: Option<Vec<String>>) -> ExecutionRequest {
        ExecutionRequest::new(
            "claude_send",
            json!({}),
            DeviceContext {
                device_id: "device-a".to_string(),
                account_id: "tenant-a".to_string(),
                scope: scope.to_string(),
                granted_scopes: Vec::new(),
                authorization_capabilities: capabilities,
            },
            ExecutionTransport::Http,
            None,
        )
    }

    #[test]
    fn empty_authorization_snapshot_denies_without_store_fallback() {
        let request = execution_request("device", Some(Vec::new()));
        let descriptor = super::super::command_manifest::descriptor("claude_send").unwrap();

        let error = authorize_capability(&request, descriptor).unwrap_err();

        assert_eq!(error.code, "missing_capability");
    }

    #[test]
    fn absent_authorization_snapshot_requests_store_fallback() {
        let request = execution_request("device", None);
        let descriptor = super::super::command_manifest::descriptor("claude_send").unwrap();

        assert_eq!(
            snapshot_capability_decision(&request.principal, &descriptor.capability),
            None
        );
    }

    #[test]
    fn service_principal_bypasses_device_capability_lookup() {
        let request = execution_request("service", None);
        let descriptor = super::super::command_manifest::descriptor("claude_send").unwrap();

        assert!(authorize_capability(&request, descriptor).is_ok());
    }

    #[test]
    fn internal_transport_requires_service_principal() {
        let descriptor = super::super::command_manifest::descriptor("claude_send").unwrap();
        let mut service = execution_request("service", None);
        service.transport = ExecutionTransport::Internal;
        assert!(authorize_transport(&service, descriptor).is_ok());

        let mut device = execution_request("device", Some(vec!["agent.run".into()]));
        device.transport = ExecutionTransport::Internal;
        assert_eq!(
            authorize_transport(&device, descriptor).unwrap_err().code,
            "command_transport_forbidden"
        );
    }

    #[test]
    fn service_principal_cannot_use_public_transports() {
        let descriptor = super::super::command_manifest::descriptor("claude_send").unwrap();
        let service = execution_request("service", None);
        assert_eq!(
            authorize_transport(&service, descriptor).unwrap_err().code,
            "command_transport_forbidden"
        );
    }

    #[test]
    fn execution_request_normalizes_the_optional_policy_id() {
        let mut camel_case = execution_request("device", Some(vec!["agent.run".into()]));
        camel_case.args = json!({ "policyId": "policy-a" });
        let camel_case = ExecutionRequest::new(
            camel_case.command,
            camel_case.args,
            camel_case.principal,
            camel_case.transport,
            None,
        );
        assert_eq!(camel_case.policy_id.as_deref(), Some("policy-a"));

        let snake_case = ExecutionRequest::new(
            "claude_send",
            json!({ "policy_id": "policy-b" }),
            camel_case.principal,
            ExecutionTransport::Http,
            None,
        );
        assert_eq!(snake_case.policy_id.as_deref(), Some("policy-b"));
    }

    #[test]
    fn protocol_request_uuid_is_stable_and_principal_scoped() {
        let principal = execution_request("device", Some(Vec::new())).principal;
        let first = derive_protocol_request_uuid(&principal, "acp", &json!(42), "claude_send");
        let retry = derive_protocol_request_uuid(&principal, "acp", &json!(42), "claude_send");
        let other_request =
            derive_protocol_request_uuid(&principal, "acp", &json!(43), "claude_send");

        assert_eq!(first, retry);
        assert_ne!(first, other_request);
        assert!(Uuid::parse_str(&first).is_ok());
    }

    #[test]
    fn protocol_idempotency_is_manifest_driven_and_retry_stable() {
        let principal = execution_request("device", Some(Vec::new())).principal;
        let first = protocol_idempotency_key("claude_send", &principal, "a2a", Some(&json!(7)));
        let retry = protocol_idempotency_key("claude_send", &principal, "a2a", Some(&json!(7)));
        let read =
            protocol_idempotency_key("claude_sidecar_status", &principal, "a2a", Some(&json!(7)));

        assert_eq!(first, retry);
        assert!(first.is_some());
        assert_eq!(read, None);
    }

    #[test]
    fn generation_and_origin_bind_responses_to_the_latest_turn() {
        let registry = RemoteExecutionRegistry::default();
        let first = registry.register("host-a", "device-a", "session-a", 100);
        assert_eq!(first.generation, 1);
        assert!(registry
            .validate(&first, "device-a", "session-a", 101)
            .is_ok());
        assert_eq!(
            registry.validate(&first, "device-b", "session-a", 101),
            Err("REMOTE_SCOPE_DENIED")
        );

        let second = registry.register("host-a", "device-a", "session-a", 200);
        assert_eq!(second.generation, 2);
        assert_eq!(
            registry.validate(&first, "device-a", "session-a", 201),
            Err("REMOTE_RESPONSE_STALE")
        );
    }

    #[test]
    fn one_shot_responses_reject_replay() {
        let registry = RemoteExecutionRegistry::default();
        let context = registry.register("host-a", "device-a", "session-a", 100);
        registry.register_pending(&context, "tool-1").unwrap();
        assert!(registry
            .validate_and_consume(&context, "device-a", "session-a", "tool-1", 101)
            .is_ok());
        assert_eq!(
            registry.validate_and_consume(&context, "device-a", "session-a", "tool-1", 102),
            Err("REMOTE_RESPONSE_STALE")
        );
    }

    #[test]
    fn responses_must_match_a_registered_pending_request() {
        let registry = RemoteExecutionRegistry::default();
        let context = registry.register("host-a", "device-a", "session-a", 100);
        assert_eq!(
            registry.validate_and_consume(&context, "device-a", "session-a", "never-pending", 101,),
            Err("REMOTE_RESPONSE_STALE")
        );
    }

    #[test]
    fn protocol_messages_reject_replay_and_close_on_terminal_message() {
        let registry = RemoteExecutionRegistry::default();
        let context = registry.register("host-a", "device-a", "session-a", 100);
        registry.register_pending(&context, "exec-1").unwrap();
        assert!(registry
            .validate_pending_message(
                &context,
                "device-a",
                "session-a",
                "exec-1",
                "message-1",
                false,
                101,
            )
            .is_ok());
        assert_eq!(
            registry.validate_pending_message(
                &context,
                "device-a",
                "session-a",
                "exec-1",
                "message-1",
                false,
                102,
            ),
            Err("REMOTE_RESPONSE_STALE")
        );
        assert!(registry
            .validate_pending_message(
                &context,
                "device-a",
                "session-a",
                "exec-1",
                "message-2",
                true,
                103,
            )
            .is_ok());
        assert_eq!(
            registry.validate_pending_message(
                &context,
                "device-a",
                "session-a",
                "exec-1",
                "message-3",
                false,
                104,
            ),
            Err("REMOTE_RESPONSE_STALE")
        );
    }

    #[test]
    fn expired_context_returns_a_retryable_disconnect_error() {
        let registry = RemoteExecutionRegistry::default();
        let context = registry.register("host-a", "device-a", "session-a", 100);
        assert_eq!(
            registry.validate(&context, "device-a", "session-a", 100 + CONTEXT_TTL_MS + 1),
            Err("REMOTE_PROXY_DISCONNECTED")
        );
    }
}
