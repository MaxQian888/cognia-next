use std::collections::{HashMap, HashSet, VecDeque};

use axum::http::StatusCode;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tracing::Instrument as _;
use uuid::Uuid;

use super::{
    command_manifest::{
        CommandApproval, CommandDescriptor, CommandIdempotency, CommandOperation, CommandTarget,
        CommandTransport,
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

    fn label(self) -> &'static str {
        match self {
            Self::Http => "http",
            Self::WebSocket => "websocket",
            Self::WebRtc => "webrtc",
            Self::Internal => "internal",
        }
    }
}

/// Which listener a request arrived on, as opposed to which protocol carried
/// it (`ExecutionTransport`).
///
/// The plaintext companion listener is hard-bound to `127.0.0.1` and never to
/// `0.0.0.0` — that bind is the entire justification for it having no TLS — so
/// a request that arrives on it demonstrably came from a process on this
/// machine. Nothing else about a request proves that: a device token, an
/// Origin header and a loopback `Host` header are all forgeable or reusable
/// from off-box.
///
/// One command needs to know. `codeserver_status` withholds the workbench's
/// loopback port from every caller, because a port on the host's loopback is
/// meaningless to anyone who cannot reach that loopback. A browser running ON
/// the host can, and telling it the port is the difference between embedding
/// the workbench and only being able to link to it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ExecutionPlane {
    /// Anything that is not provably same-machine. The default, so a path that
    /// has not thought about this discloses nothing.
    #[default]
    Network,
    /// The loopback-bound plaintext listener.
    LoopbackPlaintext,
}

#[derive(Clone, Debug)]
pub struct ExecutionRequest {
    pub command: String,
    pub args: Value,
    pub principal: DeviceContext,
    pub transport: ExecutionTransport,
    pub plane: ExecutionPlane,
    pub request_id: String,
    pub policy_id: Option<String>,
    pub idempotency_key: Option<String>,
    pub traceparent: Option<String>,
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
            // Opt-in, never inferred. Every constructor that has not proven
            // the caller is on this machine gets the conservative answer.
            plane: ExecutionPlane::Network,
            request_id: Uuid::new_v4().to_string(),
            policy_id,
            idempotency_key,
            traceparent: None,
        }
    }

    /// Record that this request arrived on the loopback-bound listener.
    ///
    /// A builder rather than a `new` parameter so every other entry point keeps
    /// the default: adding a plane argument to the constructor would have made
    /// four callers pick a value for a question they cannot answer, and the
    /// wrong answer is a disclosure.
    pub fn with_plane(mut self, plane: ExecutionPlane) -> Self {
        self.plane = plane;
        self
    }

    pub fn with_traceparent(mut self, traceparent: Option<String>) -> Self {
        self.traceparent = traceparent
            .as_deref()
            .and_then(crate::telemetry::validate_traceparent);
        self
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
    let target = super::command_manifest::descriptor(&request.command)
        .map(|descriptor| format!("{:?}", descriptor.target).to_ascii_lowercase())
        .unwrap_or_else(|| "unknown".to_string());
    let span = tracing::info_span!(
        "companion.rpc.execute",
        rpc.command = %request.command,
        rpc.target = %target,
        rpc.transport = request.transport.label(),
        rpc.outcome = tracing::field::Empty,
        request.id = %request.request_id,
        operation.id = tracing::field::Empty,
    );
    crate::telemetry::set_parent(&span, request.traceparent.as_deref());
    let result = execute_inner(state, request).instrument(span.clone()).await;
    match &result {
        Ok(ExecutionOutcome::Completed {
            operation_id,
            replayed,
            ..
        }) => {
            span.record(
                "rpc.outcome",
                if *replayed { "replayed" } else { "completed" },
            );
            if let Some(operation_id) = operation_id {
                span.record("operation.id", operation_id.as_str());
            }
        }
        Ok(ExecutionOutcome::Accepted { operation_id, .. }) => {
            span.record("rpc.outcome", "accepted");
            span.record("operation.id", operation_id.as_str());
        }
        Err(_) => {
            span.record("rpc.outcome", "error");
        }
    }
    result
}

/// Which rate-limit bucket a command is charged to.
///
/// The manifest's `operation` is the single authority — a `read` cannot change
/// anything, so a client burst of reads is a throughput question and belongs on
/// the wide bucket; `write` and `side-effect` stay on the strict one.
pub(super) fn rate_limit_class(descriptor: &CommandDescriptor) -> super::rate_limit::RequestClass {
    if descriptor.operation == CommandOperation::Read {
        super::rate_limit::RequestClass::ReadOnly
    } else {
        super::rate_limit::RequestClass::Mutating
    }
}

async fn execute_inner(
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
    if let Err(error) = authorize_capability(&request, descriptor) {
        super::audit::record_async(
            "remote_execution_authorize",
            &request.principal.device_id,
            &request.principal.scope,
            "deny",
            json!({
                "command": &request.command,
                "reason": &error.message,
            }),
        )
        .await;
        return Err(error);
    }
    authorize_approval(&request, descriptor)?;
    validate_contract_value(
        &request.request_id,
        &request.command,
        &request.args,
        cognia_headless_contract::ContractDirection::Input,
        contract_plane_for(&request.principal.scope),
    )?;

    if request.principal.scope != "service" {
        // Which bucket this call is charged to is the same question as whether
        // it can change anything, and the manifest already answers it. Reads go
        // to the wide bucket (`RateLimitConfig::read_only_default`), which was
        // sized for exactly one burst: a freshly paired client's `runSyncDown`,
        // 25 handlers back to back, each paging while the Host sets `has_more`.
        //
        // Charging that burst to the strict 10-token bucket — as this call site
        // did while it went through the unclassified `check()` — refused every
        // pull past the tenth. `runSyncDown` records the refusal per table and
        // moves on, so the tail tables ended up silently EMPTY, and the
        // `host_feature_manifest` refresh that follows was refused too, leaving
        // a correctly-paired client stuck on "the Host didn't come online".
        let class = rate_limit_class(descriptor);
        if let super::rate_limit::RateLimitDecision::Reject { retry_after } = state
            .rate_limiter
            .check_class(&request.principal.device_id, class)
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
        validate_contract_value(
            &request.request_id,
            &request.command,
            &result,
            cognia_headless_contract::ContractDirection::Output,
            contract_plane_for(&request.principal.scope),
        )?;
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
            if let Err(mut error) = validate_contract_value(
                &request.request_id,
                &request.command,
                &result,
                cognia_headless_contract::ContractDirection::Output,
                contract_plane_for(&request.principal.scope),
            ) {
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
                return Err(error);
            }
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

/// Which contract plane a request scope maps to.
///
/// `prepare_remote_args` (rpc/source_control.rs) rewrites device-scope
/// arguments from workspace-relative coordinates into real paths and leaves
/// service-scope arguments untouched, so the two planes accept different — and
/// both correct — request shapes. Validating everything against the service
/// shape rejected every device `git_*` request with 422 before dispatch.
fn contract_plane_for(scope: &str) -> cognia_headless_contract::ContractPlane {
    if scope == "service" {
        cognia_headless_contract::ContractPlane::Service
    } else {
        cognia_headless_contract::ContractPlane::Device
    }
}

// ExecutionError intentionally carries the complete receipt-ready failure
// payload used at the remote execution boundary.
#[allow(clippy::result_large_err)]
fn validate_contract_value(
    request_id: &str,
    command: &str,
    value: &Value,
    direction: cognia_headless_contract::ContractDirection,
    plane: cognia_headless_contract::ContractPlane,
) -> Result<(), ExecutionError> {
    if !super::command_manifest::headless_contract_enforced() {
        return Ok(());
    }
    let contract = super::command_manifest::headless_contract().map_err(|_| {
        let mut error = ExecutionError::new(
            request_id,
            StatusCode::SERVICE_UNAVAILABLE,
            "contract_unavailable",
            "the Headless contract catalog is unavailable",
        );
        error.retryable = false;
        error
    })?;
    let validation = match direction {
        cognia_headless_contract::ContractDirection::Input => {
            contract.validate_input_on(plane, command, value)
        }
        cognia_headless_contract::ContractDirection::Output => {
            contract.validate_output(command, value)
        }
    };
    validation.map_err(|violation| {
        super::metrics::record_contract_violation(direction);
        let (status, code, message, violations) = match violation {
            cognia_headless_contract::ContractViolation::UnknownCommand { .. } => (
                StatusCode::SERVICE_UNAVAILABLE,
                "contract_unavailable",
                "the Headless command has no generated contract",
                Vec::new(),
            ),
            cognia_headless_contract::ContractViolation::Invalid { violations, .. }
                if direction == cognia_headless_contract::ContractDirection::Input =>
            {
                (
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "contract_input_violation",
                    "the request body violates the Headless command contract",
                    violations,
                )
            }
            cognia_headless_contract::ContractViolation::Invalid { violations, .. } => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "contract_output_violation",
                "the command result violates the Headless command contract",
                violations,
            ),
        };
        let mut error = ExecutionError::new(request_id, status, code, message);
        error.retryable = false;
        error.details = json!({ "violations": violations });
        error
    })
}

#[allow(clippy::result_large_err)]
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

#[allow(clippy::result_large_err)]
fn authorize_capability(
    request: &ExecutionRequest,
    descriptor: &CommandDescriptor,
) -> Result<(), ExecutionError> {
    if request.principal.scope == "service" {
        return Ok(());
    }
    let required = [
        Some(descriptor.capability.as_str()),
        super::rpc::payload_required_capability(&request.command, &request.args),
    ];
    for capability in required.into_iter().flatten() {
        let granted = match snapshot_capability_decision(&request.principal, capability) {
            Some(granted) => granted,
            None => security_store()
                .ok_or_else(|| store_unavailable(&request.request_id))?
                .has_capability(
                    &request.principal.account_id,
                    &request.principal.device_id,
                    capability,
                )
                .map_err(|error| map_store_error(&request.request_id, error))?,
        };
        if !granted {
            let mut error = ExecutionError::new(
                &request.request_id,
                StatusCode::FORBIDDEN,
                "missing_capability",
                "the device is not authorized for this command",
            );
            error.details = json!({ "capability": capability });
            return Err(error);
        }
    }
    Ok(())
}

fn snapshot_capability_decision(principal: &DeviceContext, capability: &str) -> Option<bool> {
    principal
        .authorization_capabilities
        .as_ref()
        .map(|capabilities| capabilities.iter().any(|granted| granted == capability))
}

#[allow(clippy::result_large_err)]
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
        // The command that MINTS a lease cannot be asked to present one. Its
        // interactive approval is enforced inside the dispatch arm, by
        // `host_consent` — a human answering on the host. This arm used to
        // accept `args.confirmed == true` instead, which let the caller assert
        // its own confirmation; that is the hole `host_consent` closes, and
        // re-adding an argument check here would reopen it.
        CommandApproval::Interactive if request.command == "host_admin_lease_issue" => Ok(()),
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

#[allow(clippy::result_large_err)]
async fn dispatch(
    state: &SharedState,
    request: &ExecutionRequest,
) -> Result<Value, ExecutionError> {
    super::rpc::dispatch_canonical(
        &request.command,
        request.args.clone(),
        state,
        &request.principal,
        request.plane,
    )
    .await
    .map_err(|(status, axum::Json(error))| {
        ExecutionError::new(&request.request_id, status, error.code, error.message)
    })
}

#[allow(clippy::result_large_err)]
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
    error.details = detail
        .and_then(|value| value.get("details"))
        .cloned()
        .unwrap_or_else(|| json!({}));
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
    /// Response ids raised under a remote context, per session, oldest first.
    ///
    /// Separate from `pending` / `consumed` because the two answer different
    /// questions. Those are keyed by the context's `request_id`, so they are
    /// generation-bound: a new send retires them, which is right, because a
    /// retired context must not still satisfy single-use. Whether a request
    /// *was* remote-scoped is not generation-bound at all. The request outlives
    /// the turn that raised it, and it stays the origin device's to answer for
    /// as long as it is answerable.
    ///
    /// Bounded per session, because nothing removes a session from this
    /// registry and a long session can raise many requests.
    scoped: HashMap<String, VecDeque<String>>,
}

/// How many remote-scoped response ids to remember per session.
///
/// Only ever read on the approval path that omits a context, so a linear scan
/// of at most this many ids is cheaper than a second index.
const SCOPED_RESPONSES_PER_SESSION: usize = 512;

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
        // Retire the previous generation's keys. `scoped` is deliberately not
        // touched: it records which requests belong to a remote origin, and a
        // request raised by an earlier turn is still that turn's to answer.
        // Clearing it here is what let a later send erase the scope and hand
        // the request to any device holding a control grant.
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
        let scoped = state.scoped.entry(context.session_id.clone()).or_default();
        if !scoped.iter().any(|id| id == response_id) {
            if scoped.len() >= SCOPED_RESPONSES_PER_SESSION {
                scoped.pop_front();
            }
            scoped.push_back(response_id.to_string());
        }
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

impl RemoteExecutionRegistry {
    /// Whether `response_id` (a permission `requestId`, a plugin `toolUseId`,
    /// …) on `session_id` was issued under a remote execution context — i.e.
    /// the turn that raised it was sent by a paired device, and only that
    /// device may answer it.
    ///
    /// A request that was never registered here came from a turn the host
    /// started itself (desktop composer, IM connector, scheduler, brain-driven
    /// HostState intent). Those carry no context, so the approval arms cannot
    /// demand one; they fall back to the caller's remote-control grant
    /// instead. This read is what stops a caller from *omitting* the context
    /// to sidestep the scope check on a remote-originated request, so it reads
    /// the per-session record rather than the generation-bound keys: a request
    /// stays scoped after it was consumed, and after a later send on the same
    /// session has retired the context that raised it.
    pub fn is_remote_scoped(&self, session_id: &str, response_id: &str) -> bool {
        let state = self.state.lock();
        state
            .scoped
            .get(session_id)
            .is_some_and(|ids| ids.iter().any(|id| id == response_id))
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

    /// The bootstrap burst must land on the wide bucket.
    ///
    /// `runSyncDown` walks every companion-sync handler back to back and each
    /// pages while the Host sets `has_more`. Charged to the strict 10-token
    /// bucket, everything past the tenth pull is refused and the tail tables
    /// stay silently empty — the failure this classification exists to prevent.
    #[test]
    fn sync_bootstrap_reads_are_charged_to_the_read_only_bucket() {
        for command in [
            "sync_pull",
            "host_feature_manifest",
            "session_list",
            "message_get_by_session",
        ] {
            let descriptor = super::super::command_manifest::descriptor(command)
                .unwrap_or_else(|| panic!("{command} must be a registered command"));
            assert_eq!(
                rate_limit_class(descriptor),
                super::super::rate_limit::RequestClass::ReadOnly,
                "{command} is a read and must not spend the strict bucket"
            );
        }
    }

    #[test]
    fn writes_and_side_effects_stay_on_the_strict_bucket() {
        for command in ["claude_send", "app_settings_update"] {
            let descriptor = super::super::command_manifest::descriptor(command)
                .unwrap_or_else(|| panic!("{command} must be a registered command"));
            assert_eq!(
                rate_limit_class(descriptor),
                super::super::rate_limit::RequestClass::Mutating,
                "{command} can change state and must stay strictly limited"
            );
        }
    }

    /// Every command the manifest calls a `read` must be classified as such —
    /// a guard against the classification silently regressing to `check()`.
    #[test]
    fn manifest_read_operations_all_map_to_the_read_only_class() {
        let mut reads = 0usize;
        for descriptor in super::super::command_manifest::commands() {
            let expected = if descriptor.operation == CommandOperation::Read {
                reads += 1;
                super::super::rate_limit::RequestClass::ReadOnly
            } else {
                super::super::rate_limit::RequestClass::Mutating
            };
            assert_eq!(
                rate_limit_class(descriptor),
                expected,
                "{} classified against its manifest operation",
                descriptor.name
            );
        }
        assert!(reads > 0, "the manifest must declare read commands");
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
    fn agent_schedules_require_scheduler_and_process_capabilities() {
        let mut request = ExecutionRequest::new(
            "scheduled_task_create",
            json!({ "input": { "type": "agent" } }),
            DeviceContext {
                device_id: "device-a".to_string(),
                account_id: "tenant-a".to_string(),
                scope: "device".to_string(),
                granted_scopes: Vec::new(),
                authorization_capabilities: Some(vec!["scheduler.manage".to_string()]),
            },
            ExecutionTransport::Http,
            None,
        );
        let descriptor =
            super::super::command_manifest::descriptor("scheduled_task_create").unwrap();

        assert_eq!(
            authorize_capability(&request, descriptor).unwrap_err().code,
            "missing_capability"
        );

        request
            .principal
            .authorization_capabilities
            .as_mut()
            .unwrap()
            .push("process.spawn".to_string());
        assert!(authorize_capability(&request, descriptor).is_ok());
    }

    #[test]
    fn agent_control_grant_authorizes_the_external_agent_process_plane() {
        for command in [
            "spawn_external_agent",
            "send_to_external_agent",
            "kill_external_agent",
        ] {
            let mut request = execution_request("device", Some(vec!["process.spawn".into()]));
            request.command = command.to_string();
            let descriptor = super::super::command_manifest::descriptor(command)
                .unwrap_or_else(|| panic!("{command} must be a registered command"));

            assert!(authorize_capability(&request, descriptor).is_ok());
            assert!(
                authorize_approval(&request, descriptor).is_ok(),
                "{command} must not require a second policy after Agent Control was granted"
            );
        }
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
    fn execution_request_carries_only_valid_w3c_trace_context() {
        let valid = format!("00-{}-{}-01", "a".repeat(32), "b".repeat(16));
        let request = execution_request("service", None).with_traceparent(Some(valid.clone()));
        assert_eq!(request.traceparent.as_deref(), Some(valid.as_str()));

        let request = execution_request("service", None)
            .with_traceparent(Some("not-a-traceparent".to_string()));
        assert_eq!(request.traceparent, None);
    }

    #[test]
    fn strict_contract_errors_are_typed_and_do_not_echo_values() {
        let error = validate_contract_value(
            "request-a",
            "browser_session_ensure",
            &json!({
                "chatSessionId": "chat-a",
                "workspaceId": "workspace-a",
                "userEnabled": true,
                "unexpected": "do-not-leak-this-value",
            }),
            cognia_headless_contract::ContractDirection::Input,
            cognia_headless_contract::ContractPlane::Device,
        )
        .unwrap_err();

        assert_eq!(error.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(error.code, "contract_input_violation");
        assert_eq!(error.request_id, "request-a");
        assert!(!error.retryable);
        assert!(!error.details.to_string().contains("do-not-leak-this-value"));
    }

    /// The payloads real companion clients put on the wire must pass the
    /// enforced input contract.
    ///
    /// Every existing contract test asserts a payload the TEST author chose.
    /// None assert a payload a CLIENT actually sends, and the two had drifted:
    /// `CompanionTransport.call` does `JSON.stringify(args)` with no casing
    /// conversion, so whatever `lib/**` passes is exactly what is validated.
    /// A schema that disagrees with the caller rejects every request with 422
    /// before dispatch is ever reached — invisible to the dispatch-arm tests,
    /// which call the arms directly.
    ///
    /// Each case below is copied from the real call site named in the comment.
    /// Update them by re-reading that call site, never by relaxing the schema.
    #[test]
    fn real_client_payloads_pass_the_enforced_input_contract() {
        // lib/claude/ipc.ts:80 — sendPrompt
        let cases: &[(&str, Value)] = &[
            (
                "claude_send",
                json!({ "sessionId": "session-a", "prompt": "hello", "options": {} }),
            ),
            // lib/claude/ipc.ts:672 — approveTool
            (
                "claude_approve",
                json!({
                    "sessionId": "session-a",
                    "requestId": "request-a",
                    "decision": "allow",
                    "remoteExecutionContext": {
                        "hostId": "host-a",
                        "originDeviceId": "device-a",
                        "sessionId": "session-a",
                        "generation": 1,
                        "requestId": "request-a",
                        "issuedAt": 0,
                        "expiresAt": 0,
                    },
                }),
            ),
            // lib/git/commands.ts:62 — prepareGitTransportArgs, remote shape.
            // `adminLease` is appended at commands.ts:123 because git_clone is
            // `approval: interactive`.
            (
                "git_clone",
                json!({
                    "remoteUrl": "https://example.invalid/a.git",
                    "workspaceId": "workspace-a",
                    "destinationRelativePath": "a",
                    "adminLease": "lease-a",
                }),
            ),
            // lib/git/target.ts:46 — gitTargetArgs, the shape every other
            // git_* command carries on the device plane.
            (
                "git_status",
                json!({ "workspaceId": "workspace-a", "relativePath": "repo" }),
            ),
        ];

        let failures: Vec<String> = cases
            .iter()
            .filter_map(|(command, payload)| {
                validate_contract_value(
                    "request-a",
                    command,
                    payload,
                    cognia_headless_contract::ContractDirection::Input,
                    cognia_headless_contract::ContractPlane::Device,
                )
                .err()
                .map(|error| format!("{command}: {} {}", error.code, error.details))
            })
            .collect();

        assert!(
            failures.is_empty(),
            "real client payloads rejected by the enforced contract:\n  {}",
            failures.join("\n  ")
        );
    }

    #[test]
    fn workflow_approval_list_output_contract_accepts_the_runtime_envelope() {
        validate_contract_value(
            "request-approval-list",
            "workflow_approval_list",
            &json!({ "approvals": [] }),
            cognia_headless_contract::ContractDirection::Output,
            cognia_headless_contract::ContractPlane::Service,
        )
        .expect("workflow approval list uses an object envelope on every host");
    }

    /// Response schemas are typed from the dispatch arm's return expression,
    /// not from the `#[tauri::command]` signature — the two differ, and that is
    /// the whole reason this ratchet is per-command rather than mechanical.
    ///
    /// Serializing the REAL Rust value is what makes tightening a schema safe.
    /// Output validation is enforced at `:293` and `:362`, so a schema that
    /// disagrees with the struct turns a working command into an error
    /// response. Because these schemas are closed (`additionalProperties:
    /// false`), adding a field to one of these structs would break the command
    /// at runtime with no other signal — this test is that signal, and it goes
    /// red at compile time for a rename and at assert time for an addition.
    #[test]
    fn terminal_responses_match_their_enforced_output_contracts() {
        use cognia_terminal::complete::PathCandidate;
        use cognia_terminal::exec::TerminalExecResult;
        use cognia_terminal::host::{HostReplayBounds, HostSessionInfo, IntegrationCapabilities};
        use cognia_terminal::session::SessionOrigin;

        let session = HostSessionInfo {
            id: "session-a".to_string(),
            host_id: "host-a".to_string(),
            kind: cognia_terminal::host::SessionKind::LocalPty,
            profile_id: "profile-a".to_string(),
            project_id: Some("project-a".to_string()),
            extension_id: None,
            origin: SessionOrigin::Remote,
            shell: "/bin/zsh".to_string(),
            created_at: 1,
            last_activity_at: 2,
            current_controller: Some("device-a".to_string()),
            attached_clients: 1,
            participants: Vec::new(),
            alive: true,
            sandboxed: false,
            integration_capabilities: IntegrationCapabilities {
                osc633: true,
                command_status: true,
                cwd_tracking: true,
                degraded_reason: None,
            },
            replay: HostReplayBounds {
                first_sequence: 0,
                last_sequence: 9,
                retained_bytes: 4096,
                truncated: false,
            },
            // Skipped by serde when None, present when Some — both spellings
            // have to satisfy the same schema, so the list below sends one of
            // each rather than only the populated shape.
            ssh_host_key_status: Some("trusted".to_string()),
            ssh_host_key_fingerprint: Some("SHA256:abc".to_string()),
        };
        let mut local_session = session.clone();
        local_session.kind = cognia_terminal::host::SessionKind::Ssh;
        local_session.origin = SessionOrigin::Local;
        local_session.project_id = None;
        local_session.current_controller = None;
        local_session.ssh_host_key_status = None;
        local_session.ssh_host_key_fingerprint = None;

        let exec_ok = TerminalExecResult {
            stdout: "ok\n".to_string(),
            stderr: String::new(),
            exit_code: Some(0),
            timed_out: false,
        };
        // A timeout kill leaves no exit code. `exitCode: null` is a SUCCESSFUL
        // response, so the schema has to admit it.
        let exec_timeout = TerminalExecResult {
            stdout: String::new(),
            stderr: "timed out".to_string(),
            exit_code: None,
            timed_out: true,
        };

        let cases: Vec<(&str, Value)> = vec![
            (
                "terminal_list_all",
                serde_json::to_value(vec![session.clone(), local_session.clone()]).unwrap(),
            ),
            (
                "terminal_list_for_project",
                serde_json::to_value(vec![session]).unwrap(),
            ),
            // An empty list is the common case on a host with no sessions.
            (
                "terminal_list_all",
                serde_json::to_value(Vec::<HostSessionInfo>::new()).unwrap(),
            ),
            ("terminal_exec", serde_json::to_value(exec_ok).unwrap()),
            // Head-word completion: a bare array of executable names, and the
            // empty array a host with no match returns.
            (
                "terminal_list_path_executables",
                json!(["git", "git-lfs", "gitk"]),
            ),
            ("terminal_list_path_executables", json!([])),
            ("terminal_exec", serde_json::to_value(exec_timeout).unwrap()),
            (
                "terminal_complete_paths",
                serde_json::to_value(vec![
                    PathCandidate {
                        name: "src".to_string(),
                        is_dir: true,
                    },
                    PathCandidate {
                        name: "Cargo.toml".to_string(),
                        is_dir: false,
                    },
                ])
                .unwrap(),
            ),
            // `terminal_kill_port` returns the PIDs it signalled, and returning
            // none is a success, not an error.
            (
                "terminal_kill_port",
                serde_json::to_value(vec![4242u32]).unwrap(),
            ),
            (
                "terminal_kill_port",
                serde_json::to_value(Vec::<u32>::new()).unwrap(),
            ),
            // The one arm in this submodule that really does return null.
            ("terminal_kill", Value::Null),
        ];

        let failures: Vec<String> = cases
            .iter()
            .filter_map(|(command, value)| {
                validate_contract_value(
                    "request-a",
                    command,
                    value,
                    cognia_headless_contract::ContractDirection::Output,
                    cognia_headless_contract::ContractPlane::Device,
                )
                .err()
                .map(|error| format!("{command}: {} {}", error.code, error.details))
            })
            .collect();

        assert!(
            failures.is_empty(),
            "real terminal responses rejected by the enforced output contract:\n  {}",
            failures.join("\n  ")
        );
    }

    /// The companion assertion to the one above: the tightened schemas must
    /// still REJECT a wrong shape. A schema that accepts everything passes the
    /// test above too, so without this the ratchet could be satisfied by
    /// writing `properties` that constrain nothing.
    #[test]
    fn tightened_terminal_contracts_still_reject_wrong_shapes() {
        let rejected: Vec<(&str, Value)> = vec![
            // Was `LegacyList` — any array at all used to pass.
            ("terminal_list_all", json!([{ "id": "session-a" }])),
            // Was `LegacyResult` — a bare string used to pass.
            ("terminal_exec", json!("ok")),
            // exitCode is an integer or null, never a string.
            (
                "terminal_exec",
                json!({ "stdout": "", "stderr": "", "exitCode": "0", "timedOut": false }),
            ),
            ("terminal_complete_paths", json!([{ "name": "src" }])),
            // Executable names are a bare string array. An object wrapper and a
            // non-string element are the two ways a hand-written arm gets this
            // wrong, and neither fails locally — only here.
            (
                "terminal_list_path_executables",
                json!({ "names": ["git"] }),
            ),
            ("terminal_list_path_executables", json!([1, 2])),
            ("terminal_kill_port", json!(["4242"])),
        ];

        let accepted: Vec<&str> = rejected
            .iter()
            .filter(|(command, value)| {
                validate_contract_value(
                    "request-a",
                    command,
                    value,
                    cognia_headless_contract::ContractDirection::Output,
                    cognia_headless_contract::ContractPlane::Device,
                )
                .is_ok()
            })
            .map(|(command, _)| *command)
            .collect();

        assert!(
            accepted.is_empty(),
            "these malformed responses still pass — the schema is not actually tightened: {accepted:?}"
        );
    }

    /// `secret_store_get` and its `keyring_secret_get` alias were declared
    /// `LegacyRecord` — `{"type":"object"}`. The arm returns
    /// `to_json(Option<String>)`, so every SUCCESSFUL read put a bare string
    /// (or null, for an absent key) on the wire and the enforced output
    /// contract rejected it with `contract_output_violation`. Reading a secret
    /// from any remote or mobile client could not succeed.
    ///
    /// The bug hid inside the "vacuous response schema" pile because
    /// `LegacyRecord` reads like a catch-all. It is not one: it constrains the
    /// root to an object, and these two commands never return an object.
    #[test]
    fn secret_reads_put_a_bare_string_or_null_on_the_wire() {
        for command in ["secret_store_get", "keyring_secret_get"] {
            for value in [json!("s3cret"), Value::Null] {
                validate_contract_value(
                    "request-a",
                    command,
                    &value,
                    cognia_headless_contract::ContractDirection::Output,
                    cognia_headless_contract::ContractPlane::Device,
                )
                .unwrap_or_else(|error| {
                    panic!(
                        "{command} rejected {value}: {} {}",
                        error.code, error.details
                    )
                });
            }
        }
    }

    #[test]
    fn chat_submodule_responses_match_their_enforced_output_contracts() {
        use crate::agents::commands::{AgentReadResult, AgentWriteResult};
        use crate::claude::commands::SidecarStatus;

        let read_ok = AgentReadResult {
            path: Some("/home/a/.claude/settings.json".to_string()),
            exists: true,
            writable: true,
            format: "json".to_string(),
            raw: "{}".to_string(),
            parsed: json!({ "model": "opus" }),
            parse_error: None,
        };
        // The agent isn't supported on this OS: path is null and raw is empty.
        let read_absent = AgentReadResult {
            path: None,
            exists: false,
            writable: false,
            format: "toml".to_string(),
            raw: String::new(),
            parsed: Value::Null,
            parse_error: None,
        };
        // The file existed but would not parse — the only shape that carries
        // `parseError`, which serde omits entirely in the other two.
        let read_broken = AgentReadResult {
            path: Some("/home/a/.codex/config.toml".to_string()),
            exists: true,
            writable: true,
            format: "toml".to_string(),
            raw: "{{{".to_string(),
            parsed: Value::Null,
            parse_error: Some("expected a table".to_string()),
        };

        let cases: Vec<(&str, Value)> = vec![
            (
                "claude_sidecar_status",
                serde_json::to_value(SidecarStatus { ready: true }).unwrap(),
            ),
            ("read_agent_config", serde_json::to_value(read_ok).unwrap()),
            (
                "read_agent_config",
                serde_json::to_value(read_absent).unwrap(),
            ),
            (
                "read_agent_config",
                serde_json::to_value(read_broken).unwrap(),
            ),
            (
                "write_agent_config",
                serde_json::to_value(AgentWriteResult {
                    path: "/home/a/.claude/settings.json".to_string(),
                    backup_path: Some("/home/a/.claude/settings.json.bak".to_string()),
                })
                .unwrap(),
            ),
            (
                "write_agent_config",
                serde_json::to_value(AgentWriteResult {
                    path: "/home/a/.claude/settings.json".to_string(),
                    backup_path: None,
                })
                .unwrap(),
            ),
            // Same arm, same `Ok(Value::Null)`, four command names. The two
            // aliases were declared LegacyResult while their canonical twins
            // were already NullResult.
            ("secret_store_set", Value::Null),
            ("keyring_secret_set", Value::Null),
            ("secret_store_delete", Value::Null),
            ("keyring_secret_clear", Value::Null),
        ];

        let failures: Vec<String> = cases
            .iter()
            .filter_map(|(command, value)| {
                validate_contract_value(
                    "request-a",
                    command,
                    value,
                    cognia_headless_contract::ContractDirection::Output,
                    cognia_headless_contract::ContractPlane::Device,
                )
                .err()
                .map(|error| format!("{command}: {} {}", error.code, error.details))
            })
            .collect();

        assert!(
            failures.is_empty(),
            "real chat-submodule responses rejected by the enforced output contract:\n  {}",
            failures.join("\n  ")
        );
    }

    #[test]
    fn tightened_chat_contracts_still_reject_wrong_shapes() {
        let rejected: Vec<(&str, Value)> = vec![
            // AgentReadResult carries no rename_all, so the wire keys are
            // snake_case. A camelCase payload is a different, wrong shape.
            (
                "read_agent_config",
                json!({
                    "path": null, "exists": false, "writable": false,
                    "format": "json", "raw": "", "parsed": null,
                    "parseError": 42
                }),
            ),
            // `format` is one of exactly three vendor formats.
            (
                "read_agent_config",
                json!({
                    "path": null, "exists": false, "writable": false,
                    "format": "yaml", "raw": "", "parsed": null
                }),
            ),
            ("claude_sidecar_status", json!({ "ready": "yes" })),
            ("write_agent_config", json!({})),
            // A secret is a string or null — never a wrapper object.
            ("secret_store_get", json!({ "value": "s3cret" })),
        ];

        let accepted: Vec<&str> = rejected
            .iter()
            .filter(|(command, value)| {
                validate_contract_value(
                    "request-a",
                    command,
                    value,
                    cognia_headless_contract::ContractDirection::Output,
                    cognia_headless_contract::ContractPlane::Device,
                )
                .is_ok()
            })
            .map(|(command, _)| *command)
            .collect();

        assert!(
            accepted.is_empty(),
            "these malformed responses still pass — the schema is not actually tightened: {accepted:?}"
        );
    }

    /// `fleet_get_snapshot` was declared `LegacyList` — `{"type":"array"}` —
    /// while its arm serializes `FleetSnapshot`, a struct, which is always a
    /// JSON object. Every snapshot request failed enforced output validation,
    /// so no remote or mobile client could load the Agent Fleet view at all.
    ///
    /// The contradiction was already written down beside the arm: the
    /// `fleet_event_payload` helper immediately above it calls
    /// `as_object_mut()` and errors with "fleet snapshot must serialize as an
    /// object". Nothing compared that to the declared response schema.
    #[test]
    fn fleet_snapshot_is_an_object_not_an_array() {
        let snapshot =
            serde_json::to_value(crate::fleet::registry::FleetRegistry::new().snapshot(0)).unwrap();
        assert!(
            snapshot.is_object(),
            "FleetSnapshot must serialize as an object: {snapshot}"
        );

        validate_contract_value(
            "request-a",
            "fleet_get_snapshot",
            &snapshot,
            cognia_headless_contract::ContractDirection::Output,
            cognia_headless_contract::ContractPlane::Device,
        )
        .unwrap_or_else(|error| {
            panic!(
                "fleet_get_snapshot rejected a real snapshot: {} {}",
                error.code, error.details
            )
        });
    }

    #[test]
    fn diagnostics_submodule_responses_match_their_enforced_output_contracts() {
        let cases: Vec<(&str, Value)> = vec![
            // An empty log directory still returns the full envelope.
            (
                "logs_query",
                json!({
                    "entries": [],
                    "fileSize": 0,
                    "scannedBytes": 0,
                    "truncated": false,
                    "path": "/var/log/cognia/cognia.jsonl"
                }),
            ),
            // A populated entry, plus one where serde skips epochMs and fields.
            (
                "logs_query",
                json!({
                    "entries": [
                        {
                            "timestamp": "2026-08-15T00:00:00Z",
                            "epochMs": 1_755_216_000_000i64,
                            "level": "INFO",
                            "target": "cognia::companion",
                            "message": "listening",
                            "fields": { "port": 8765 }
                        },
                        {
                            "timestamp": "2026-08-15T00:00:01Z",
                            "level": "WARN",
                            "target": "cognia::fleet",
                            "message": "slow"
                        }
                    ],
                    "fileSize": 4096,
                    "scannedBytes": 4096,
                    "truncated": true,
                    "path": "/var/log/cognia/cognia.jsonl"
                }),
            ),
            ("logs_list_files", json!([])),
            (
                "logs_list_files",
                json!([
                    { "name": "cognia.jsonl", "size": 10, "modifiedMs": 1 },
                    { "name": "cognia.log", "size": 0 }
                ]),
            ),
            (
                "fleet_worker_enrollment_create",
                json!({
                    "enrollment": "enroll-a",
                    "expiresAtMs": 1_755_216_600_000i64,
                    "baseUrl": "https://worker.example",
                    "fingerprint": "sha256:abc",
                    "tenantId": "tenant-a"
                }),
            ),
            ("fleet_worker_list", json!([])),
            // serde(flatten): DeviceSummary's fields sit BESIDE hostRef, not
            // nested under a `device` key.
            (
                "fleet_worker_list",
                json!([{
                    "deviceId": "device-a",
                    "displayName": "Worker A",
                    "role": "worker",
                    "status": "active",
                    "createdAt": 1,
                    "updatedAt": 2,
                    "capabilities": ["agent.worker"],
                    "hostRef": "host-a"
                }]),
            ),
            // Every one of these arms returns a bare bool.
            ("fleet_permission_respond", json!(true)),
            ("fleet_question_respond", json!(false)),
            ("fleet_question_reject", json!(true)),
            // Result<String, _>.
            ("fleet_opencode_send_message", json!("message-a")),
            // `.map(|()| Value::Null)` — provably null, but spelled differently
            // from the `Ok(Value::Null)` the other null arms use.
            ("fleet_focus_terminal", Value::Null),
            ("fleet_interrupt_session", Value::Null),
            // kind=entry carries jti+expiresAt; kind=surface carries neither.
            (
                "lark_entry_issue",
                json!({ "token": "t", "jti": "j", "expiresAt": 1_000 }),
            ),
            ("lark_entry_issue", json!({ "token": "t" })),
            ("lark_result_complete", json!({ "accepted": true })),
            ("lark_metrics_record", json!({ "ok": true })),
        ];

        let failures: Vec<String> = cases
            .iter()
            .filter_map(|(command, value)| {
                validate_contract_value(
                    "request-a",
                    command,
                    value,
                    cognia_headless_contract::ContractDirection::Output,
                    cognia_headless_contract::ContractPlane::Device,
                )
                .err()
                .map(|error| format!("{command}: {} {}", error.code, error.details))
            })
            .collect();

        assert!(
            failures.is_empty(),
            "real diagnostics responses rejected by the enforced output contract:\n  {}",
            failures.join("\n  ")
        );
    }

    #[test]
    fn tightened_diagnostics_contracts_still_reject_wrong_shapes() {
        let rejected: Vec<(&str, Value)> = vec![
            // The bug this batch fixed, asserted from the other direction.
            ("fleet_get_snapshot", json!([])),
            ("logs_query", json!([])),
            // `entries` is required even when empty.
            (
                "logs_query",
                json!({ "fileSize": 0, "scannedBytes": 0, "truncated": false, "path": "/p" }),
            ),
            // The pre-flatten shape, which would nest the device fields.
            (
                "fleet_worker_list",
                json!([{ "device": { "deviceId": "device-a" }, "hostRef": "host-a" }]),
            ),
            ("fleet_permission_respond", json!("true")),
            ("fleet_opencode_send_message", json!({ "id": "message-a" })),
            // `ok` is literal true — a false here would mean the arm returned
            // success for an unknown metric, which it never does.
            ("lark_metrics_record", json!({ "ok": false })),
            ("lark_entry_issue", json!({ "jti": "j" })),
        ];

        let accepted: Vec<&str> = rejected
            .iter()
            .filter(|(command, value)| {
                validate_contract_value(
                    "request-a",
                    command,
                    value,
                    cognia_headless_contract::ContractDirection::Output,
                    cognia_headless_contract::ContractPlane::Device,
                )
                .is_ok()
            })
            .map(|(command, _)| *command)
            .collect();

        assert!(
            accepted.is_empty(),
            "these malformed responses still pass — the schema is not actually tightened: {accepted:?}"
        );
    }

    #[test]
    fn failed_receipt_replay_preserves_contract_violation_details() {
        let receipt = json!({
            "httpStatus": 500,
            "error": {
                "code": "contract_output_violation",
                "message": "response violates the command contract",
                "retryable": true,
                "details": {
                    "violations": [{
                        "instancePath": "/result",
                        "schemaPath": "/properties/result/type"
                    }]
                }
            }
        });

        let error = replay_receipt("request-a", "operation-a".to_string(), &receipt.to_string())
            .unwrap_err();

        assert_eq!(error.code, "contract_output_violation");
        assert_eq!(error.operation_id.as_deref(), Some("operation-a"));
        assert_eq!(error.details, receipt["error"]["details"]);
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

    #[test]
    fn remote_scoped_read_tracks_pending_and_consumed_requests() {
        let registry = RemoteExecutionRegistry::default();
        assert!(!registry.is_remote_scoped("session-a", "req-1"));

        let context = registry.register("host-a", "device-a", "session-a", 100);
        assert!(!registry.is_remote_scoped("session-a", "req-1"));

        registry
            .register_pending(&context, "req-1")
            .expect("pending registers");
        assert!(registry.is_remote_scoped("session-a", "req-1"));
        assert!(!registry.is_remote_scoped("session-b", "req-1"));
        assert!(!registry.is_remote_scoped("session-a", "req-2"));

        registry
            .validate_and_consume(&context, "device-a", "session-a", "req-1", 150)
            .expect("consume succeeds");
        // Consumed stays scoped: a second answer without a context must not
        // be admitted on the grant path either.
        assert!(registry.is_remote_scoped("session-a", "req-1"));
    }

    #[test]
    fn a_later_send_does_not_unscope_an_earlier_request() {
        // `register` retires the previous generation's keys, which is right for
        // single-use. It must not also retire the fact that the request came
        // from a remote origin: the approval arm reads that to refuse a device
        // answering without a context, and every ordinary turn calls `register`
        // again. Erasing it here handed a phone's pending approval to any
        // device holding a control grant, repeatedly, since that path consumes
        // nothing.
        let registry = RemoteExecutionRegistry::default();
        let first = registry.register("host-a", "device-a", "session-a", 100);
        registry
            .register_pending(&first, "req-1")
            .expect("pending registers");
        assert!(registry.is_remote_scoped("session-a", "req-1"));

        // The same session sends again: a new generation, and the old context
        // is now stale for validation.
        let second = registry.register("host-a", "device-a", "session-a", 200);
        assert_ne!(first.request_id, second.request_id);
        assert!(registry.is_remote_scoped("session-a", "req-1"));
        assert_eq!(
            registry.validate_and_consume(&first, "device-a", "session-a", "req-1", 250),
            Err("REMOTE_RESPONSE_STALE"),
            "a retired context still cannot answer"
        );

        // Requests the session never raised remain unscoped, so a
        // host-originated approval still falls back to the control grant.
        assert!(!registry.is_remote_scoped("session-a", "req-2"));
        assert!(!registry.is_remote_scoped("session-b", "req-1"));
    }

    #[test]
    fn the_scoped_record_is_bounded_per_session() {
        // Nothing removes a session from this registry, so the record of which
        // requests were remote-scoped has to have a ceiling of its own.
        let registry = RemoteExecutionRegistry::default();
        let context = registry.register("host-a", "device-a", "session-a", 100);
        for index in 0..(SCOPED_RESPONSES_PER_SESSION + 10) {
            registry
                .register_pending(&context, &format!("req-{index}"))
                .expect("pending registers");
        }
        let newest = format!("req-{}", SCOPED_RESPONSES_PER_SESSION + 9);
        assert!(registry.is_remote_scoped("session-a", &newest));
        assert!(
            !registry.is_remote_scoped("session-a", "req-0"),
            "the oldest ids are evicted rather than growing without bound"
        );
    }
}
