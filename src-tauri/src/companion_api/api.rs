//! Canonical Companion device-key authentication and API adapters.

use axum::{
    extract::{rejection::JsonRejection, ConnectInfo, Path, Request, State},
    http::{header::AUTHORIZATION, HeaderMap, StatusCode},
    middleware::{from_fn, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Extension, Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use cognia_signaling_core::{proto::RoomDescriptor, protocol::validate_room_descriptor};
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::net::SocketAddr;

use super::signaling::envelope::{
    build_room_descriptor, SignalingIdentity, SIGNALING_KEY_NAMESPACE,
};
use super::{
    command_manifest::{CommandApproval, CommandIdempotency, CommandTarget, CommandTransport},
    deployment::{deployment_mode, DeploymentMode},
    middleware::DeviceContext,
    replay_cache::ReplayCache,
    security_store::{security_store, SecurityStore, SecurityStoreError},
    SharedState,
};

const LOCAL_TENANT_ID: &str = "local_acct_a";
const CHALLENGE_TTL_SECS: i64 = 60;
const ACCESS_TOKEN_TTL_SECS: i64 = 5 * 60;
const SOCKET_TICKET_TTL_SECS: i64 = 60;
const PROOF_CLOCK_SKEW_SECS: i64 = 60;
const MAX_POLICY_TTL_SECS: i64 = 30 * 24 * 60 * 60;
const MAX_POLICY_BYTES: usize = 16 * 1024;
const MAX_POLICY_COMMANDS: usize = 64;
const ROOM_DESCRIPTOR_TTL_MS: i64 = 10 * 365 * 24 * 60 * 60 * 1_000;

static ACCESS_TOKEN_AUTHORITY: Lazy<AccessTokenAuthority> = Lazy::new(AccessTokenAuthority::random);
static DPOP_REPLAY_CACHE: Lazy<ReplayCache> = Lazy::new(ReplayCache::new);

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/api/auth/config", get(auth_config_handler))
        .route("/api/auth/device/challenge", post(challenge_handler))
        .route("/api/auth/device/register", post(register_handler))
        .route("/api/auth/worker/register", post(worker_register_handler))
        .route("/api/auth/token", post(token_handler))
        .route("/api/auth/socket-ticket", post(socket_ticket_handler))
        .layer(from_fn(super::middleware::pre_auth_rate_limit))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthConfigResponse {
    deployment_mode: &'static str,
    host_id: String,
    tenant_id: Option<String>,
    oidc: Option<OidcPublicConfig>,
    signaling: SignalingPublicConfig,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OidcPublicConfig {
    issuer: String,
    audience: String,
    web_client_id: String,
    scopes: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SignalingPublicConfig {
    url: String,
    ice_servers: Vec<Value>,
}

async fn auth_config_handler(State(state): State<SharedState>, headers: HeaderMap) -> Response {
    let mode = deployment_mode();
    let host_id = super::healthz::derive_server_id(&state.secret.read());
    let oidc = if mode == DeploymentMode::MultiTenant {
        match (
            non_empty_env(super::oidc::ENV_ISSUER),
            non_empty_env(super::oidc::ENV_AUDIENCE),
            non_empty_env("COGNIA_LOGTO_WEB_CLIENT_ID"),
        ) {
            (Some(issuer), Some(audience), Some(web_client_id)) => {
                let mut scopes = vec!["openid".to_string(), "offline_access".to_string()];
                if let Some(raw) = non_empty_env(super::oidc::ENV_REQUIRED_SCOPES) {
                    for scope in
                        raw.split(|character: char| character == ',' || character.is_whitespace())
                    {
                        if !scope.is_empty() && !scopes.iter().any(|existing| existing == scope) {
                            scopes.push(scope.to_string());
                        }
                    }
                }
                Some(OidcPublicConfig {
                    issuer,
                    audience,
                    web_client_id,
                    scopes,
                })
            }
            _ => {
                return ApiError::unavailable(
                    "multi-tenant browser authentication is not fully configured",
                )
                .into_response()
            }
        }
    } else {
        None
    };
    let signaling_url = non_empty_env("COGNIA_PUBLIC_SIGNALING_URL")
        .unwrap_or_else(|| same_origin_signaling_url(&headers));
    Json(AuthConfigResponse {
        deployment_mode: match mode {
            DeploymentMode::SingleUser => "single-user",
            DeploymentMode::MultiTenant => "multi-tenant",
        },
        host_id,
        tenant_id: (mode == DeploymentMode::SingleUser).then(|| LOCAL_TENANT_ID.to_string()),
        oidc,
        signaling: SignalingPublicConfig {
            url: signaling_url,
            ice_servers: vec![
                json!({ "urls": ["stun:stun.l.google.com:19302"] }),
                json!({ "urls": ["stun:stun.cloudflare.com:3478"] }),
            ],
        },
    })
    .into_response()
}

fn non_empty_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn same_origin_signaling_url(headers: &HeaderMap) -> String {
    let scheme = headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .map(|value| {
            if value.eq_ignore_ascii_case("http") {
                "ws"
            } else {
                "wss"
            }
        })
        .unwrap_or("wss");
    let host = headers
        .get("x-forwarded-host")
        .or_else(|| headers.get("host"))
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .unwrap_or("localhost");
    format!("{scheme}://{host}/signaling")
}

pub async fn require_device_access(
    State(state): State<SharedState>,
    mut request: Request,
    next: Next,
) -> Response {
    match authenticate_device_request(&state, &request) {
        Ok(context) => {
            request.extensions_mut().insert(context);
            next.run(request).await
        }
        Err(error) => error.into_response(),
    }
}

pub async fn require_owner_access(
    State(state): State<SharedState>,
    mut request: Request,
    next: Next,
) -> Response {
    match authenticate_owner_request(&state, &request) {
        Ok(context) => {
            request.extensions_mut().insert(context);
            next.run(request).await
        }
        Err(error) => error.into_response(),
    }
}

/// Return the authenticated device identity and the currently pinned host
/// identity. Authentication is performed by [`require_device_access`].
pub(crate) async fn whoami_handler(Extension(context): Extension<DeviceContext>) -> Response {
    (
        StatusCode::OK,
        Json(json!({
            "deviceId": context.device_id,
            "accountId": context.account_id,
            "serverVersion": env!("CARGO_PKG_VERSION"),
            "tlsFingerprint": super::tls_fingerprint(),
        })),
    )
        .into_response()
}

fn authenticate_owner_request(
    _state: &SharedState,
    request: &Request,
) -> Result<DeviceContext, ApiError> {
    if deployment_mode() == DeploymentMode::SingleUser
        && request.uri().path() == "/api/invitations"
        && !request
            .extensions()
            .get::<ConnectInfo<SocketAddr>>()
            .is_some_and(|peer| peer.0.ip().is_loopback())
    {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "loopback_required",
            "single-user Owner invitations can only be created from loopback",
        ));
    }
    let access = decode_access_token(bearer_token(request.headers())?)?;
    let security = store()?;
    let snapshot = security
        .authorization_snapshot(&access.tenant_id, &access.sub)
        .map_err(store_error)?
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::UNAUTHORIZED,
                "device_unavailable",
                "the device is unknown or revoked",
            )
        })?;
    if snapshot.key_thumbprint != access.cnf.key_thumbprint
        || !snapshot
            .capabilities
            .iter()
            .any(|capability| capability == "host.admin")
    {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "owner_context_required",
            "an active Owner device is required",
        ));
    }
    let proof = request
        .headers()
        .get("dpop")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::UNAUTHORIZED,
                "missing_device_proof",
                "a DPoP device proof is required",
            )
        })?;
    let verified_proof = verify_device_proof(
        &snapshot.public_key_pem,
        proof,
        &access.jti,
        request.method().as_str(),
        request.uri().path(),
        unix_time_secs(),
    )?;
    consume_device_proof(&access.tenant_id, &access.sub, &verified_proof)?;
    Ok(DeviceContext {
        device_id: access.sub,
        account_id: access.tenant_id,
        scope: "owner".to_string(),
        granted_scopes: Vec::new(),
        authorization_capabilities: Some(snapshot.capabilities),
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevicesResponse {
    devices: Vec<super::security_store::DeviceSummary>,
}

pub(crate) async fn devices_handler(
    Extension(context): Extension<DeviceContext>,
) -> ApiResult<DevicesResponse> {
    let devices = store()?
        .list_devices(&context.account_id)
        .map_err(store_error)?;
    Ok(Json(DevicesResponse { devices }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceCapabilitiesRequest {
    capabilities: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceCapabilitiesResponse {
    device_id: String,
    capabilities: Vec<String>,
}

pub(crate) async fn replace_device_capabilities_handler(
    Path(device_id): Path<String>,
    Extension(context): Extension<DeviceContext>,
    body: Result<Json<ReplaceCapabilitiesRequest>, JsonRejection>,
) -> ApiResult<ReplaceCapabilitiesResponse> {
    let request = parse_public_json(body)?;
    let capabilities = store()?
        .replace_device_capabilities(
            &context.account_id,
            &context.device_id,
            &device_id,
            &request.capabilities,
            unix_time_secs(),
        )
        .map_err(store_error)?;
    Ok(Json(ReplaceCapabilitiesResponse {
        device_id,
        capabilities,
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvitationRequest {
    ttl_seconds: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InvitationResponse {
    invitation: String,
    expires_in: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerEnrollmentResponse {
    enrollment: String,
    expires_in: i64,
}

pub(crate) async fn worker_enrollment_handler(
    Extension(context): Extension<DeviceContext>,
    body: Result<Json<InvitationRequest>, JsonRejection>,
) -> ApiResult<WorkerEnrollmentResponse> {
    let request = parse_public_json(body)?;
    let ttl = request.ttl_seconds.unwrap_or(600);
    if !(1..=3_600).contains(&ttl) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_worker_enrollment_ttl",
            "ttlSeconds must be between 1 and 3600",
        ));
    }
    let enrollment = store()?
        .create_worker_enrollment(
            &context.account_id,
            &context.device_id,
            unix_time_secs(),
            ttl,
        )
        .map_err(store_error)?;
    Ok(Json(WorkerEnrollmentResponse {
        enrollment,
        expires_in: ttl,
    }))
}

pub(crate) async fn invitation_handler(
    Extension(context): Extension<DeviceContext>,
    body: Result<Json<InvitationRequest>, JsonRejection>,
) -> ApiResult<InvitationResponse> {
    let request = parse_public_json(body)?;
    if deployment_mode() != DeploymentMode::SingleUser {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "oidc_registration_required",
            "multi-tenant devices register through OIDC instead of Owner invitations",
        ));
    }
    let ttl = request.ttl_seconds.unwrap_or(600);
    if !(1..=3_600).contains(&ttl) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_invitation_ttl",
            "ttlSeconds must be between 1 and 3600",
        ));
    }
    let invitation = store()?
        .create_owner_invitation(
            &context.account_id,
            &context.device_id,
            unix_time_secs(),
            ttl,
        )
        .map_err(store_error)?;
    Ok(Json(InvitationResponse {
        invitation,
        expires_in: ttl,
    }))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRevocationResponse {
    revoked_device_id: String,
}

pub(crate) async fn revoke_device_handler(
    Path(device_id): Path<String>,
    Extension(context): Extension<DeviceContext>,
    State(state): State<SharedState>,
) -> ApiResult<DeviceRevocationResponse> {
    store()?
        .revoke_device(
            &context.account_id,
            &context.device_id,
            &device_id,
            false,
            unix_time_secs(),
        )
        .map_err(store_error)?;
    cleanup_signaling(&device_id)?;
    super::signaling::refresh_installed_hub().map_err(|error| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "signaling_revocation_activate_failed",
            error,
        )
    })?;
    state.deny_list.revoke(device_id.clone());
    state.event_bus.publish(
        "security://device-revoked".to_string(),
        json!({
            "tenantId": context.account_id,
            "deviceId": device_id,
        }),
    );
    Ok(Json(DeviceRevocationResponse {
        revoked_device_id: device_id,
    }))
}

pub(crate) async fn operation_handler(
    Path(operation_id): Path<String>,
    Extension(context): Extension<DeviceContext>,
) -> Response {
    match store().and_then(|store| {
        store
            .operation(&context.account_id, &context.device_id, &operation_id)
            .map_err(store_error)
    }) {
        Ok(Some(operation)) => (StatusCode::OK, Json(operation)).into_response(),
        Ok(None) => ApiError::new(
            StatusCode::NOT_FOUND,
            "operation_not_found",
            "the requested operation does not exist for this device",
        )
        .into_response(),
        Err(error) => error.into_response(),
    }
}

pub(crate) async fn internal_operation_handler(
    Path(operation_id): Path<String>,
    Extension(context): Extension<DeviceContext>,
) -> Response {
    let request_id = uuid::Uuid::new_v4().to_string();
    internal_operation_response(store(), &context, operation_id, request_id)
}

fn internal_operation_response(
    store: Result<std::sync::Arc<SecurityStore>, ApiError>,
    context: &DeviceContext,
    operation_id: String,
    request_id: String,
) -> Response {
    match store.and_then(|store| {
        store
            .operation(&context.account_id, &context.device_id, &operation_id)
            .map_err(store_error)
    }) {
        Ok(Some(operation)) => (StatusCode::OK, Json(operation)).into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(json!({
                "code": "operation_not_found",
                "message": "the requested operation does not exist for this service principal",
                "requestId": request_id,
                "retryable": false,
                "details": {},
                "operationId": operation_id,
            })),
        )
            .into_response(),
        Err(error) => (
            error.status,
            Json(json!({
                "code": error.code,
                "message": error.message,
                "requestId": request_id,
                "retryable": error.retryable,
                "details": {},
                "operationId": operation_id,
            })),
        )
            .into_response(),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoliciesResponse {
    policies: Vec<super::security_store::HostPolicySummary>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePolicyRequest {
    capability: String,
    commands: Vec<String>,
    #[serde(default = "empty_json_object")]
    constraints: serde_json::Value,
    expires_at: i64,
}

pub(crate) async fn policies_handler(
    Extension(context): Extension<DeviceContext>,
) -> ApiResult<PoliciesResponse> {
    let policies = store()?
        .list_host_policies(&context.account_id, unix_time_secs())
        .map_err(store_error)?;
    Ok(Json(PoliciesResponse { policies }))
}

pub(crate) async fn create_policy_handler(
    Extension(context): Extension<DeviceContext>,
    body: Result<Json<CreatePolicyRequest>, JsonRejection>,
) -> ApiResult<super::security_store::HostPolicySummary> {
    let request = parse_public_json(body)?;
    validate_policy_request(&request, unix_time_secs())?;
    let policy = json!({
        "version": 1,
        "commands": request.commands,
        "constraints": request.constraints,
    });
    let created = store()?
        .create_host_policy(
            &context.account_id,
            &context.device_id,
            &request.capability,
            &policy,
            Some(request.expires_at),
            unix_time_secs(),
        )
        .map_err(store_error)?;
    Ok(Json(created))
}

fn empty_json_object() -> serde_json::Value {
    json!({})
}

fn validate_policy_request(request: &CreatePolicyRequest, now: i64) -> Result<(), ApiError> {
    if request.expires_at <= now || request.expires_at > now.saturating_add(MAX_POLICY_TTL_SECS) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_policy_expiry",
            "expiresAt must be in the future and no more than 30 days away",
        ));
    }
    if request.capability == "service.internal"
        || request.commands.is_empty()
        || request.commands.len() > MAX_POLICY_COMMANDS
    {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_policy_scope",
            "a policy must cover between 1 and 64 non-service commands",
        ));
    }
    if !request.constraints.is_object()
        || serde_json::to_vec(&request.constraints)
            .map(|bytes| bytes.len() > MAX_POLICY_BYTES)
            .unwrap_or(true)
    {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_policy_constraints",
            "policy constraints must be a JSON object no larger than 16 KiB",
        ));
    }
    if request.capability == "process.spawn"
        && request
            .constraints
            .as_object()
            .is_none_or(serde_json::Map::is_empty)
    {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "process_policy_constraints_required",
            "process.spawn policies must constrain at least one request field",
        ));
    }
    let mut unique = std::collections::HashSet::with_capacity(request.commands.len());
    for command in &request.commands {
        let descriptor = super::command_manifest::descriptor(command).ok_or_else(|| {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                "invalid_policy_command",
                "a policy command is not registered",
            )
        })?;
        if !unique.insert(command)
            || descriptor.target == CommandTarget::Service
            || descriptor.approval != CommandApproval::SignedPolicy
            || descriptor.capability != request.capability
        {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "invalid_policy_command",
                "every policy command must be a unique, device-reachable signed-policy command with the declared capability",
            ));
        }
    }
    Ok(())
}

pub async fn rpc_handler(
    Path(name): Path<String>,
    Extension(context): Extension<DeviceContext>,
    headers: HeaderMap,
    State(state): State<SharedState>,
    body: Result<Json<serde_json::Value>, JsonRejection>,
) -> Response {
    let observation = super::metrics::RpcObservation::start(super::metrics::RpcPlane::Public);
    let args = match parse_public_json(body) {
        Ok(args) => args,
        Err(error) => {
            observation.finish(super::metrics::RpcOutcome::Error { saturated: false });
            return error.into_response();
        }
    };
    let idempotency_key = headers
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let request = super::remote_execution::ExecutionRequest::new(
        name,
        args,
        context,
        super::remote_execution::ExecutionTransport::Http,
        idempotency_key,
    )
    .with_traceparent(
        headers
            .get("traceparent")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned),
    );
    match super::remote_execution::execute(&state, request).await {
        Ok(super::remote_execution::ExecutionOutcome::Completed {
            request_id,
            operation_id,
            result,
            replayed,
        }) => {
            if replayed {
                super::metrics::record_operation(super::metrics::OperationOutcome::Replayed);
            } else if operation_id.is_some() {
                super::metrics::record_operation(super::metrics::OperationOutcome::Completed);
            }
            observation.finish(super::metrics::RpcOutcome::Completed);
            (
                StatusCode::OK,
                Json(completed_rpc_response(request_id, operation_id, result)),
            )
                .into_response()
        }
        Ok(super::remote_execution::ExecutionOutcome::Accepted {
            request_id,
            operation_id,
        }) => {
            super::metrics::record_operation(super::metrics::OperationOutcome::Accepted);
            observation.finish(super::metrics::RpcOutcome::Accepted);
            (
                StatusCode::ACCEPTED,
                Json(json!({
                    "requestId": request_id,
                    "operationId": operation_id,
                    "status": "running",
                })),
            )
                .into_response()
        }
        Err(error) => {
            let saturated = matches!(
                error.status,
                StatusCode::TOO_MANY_REQUESTS | StatusCode::SERVICE_UNAVAILABLE
            );
            observation.finish(super::metrics::RpcOutcome::Error { saturated });
            execution_error_response(error)
        }
    }
}

/// Loopback Headless RPC adapter. Authentication is provided by
/// `require_service_jwt`; command governance and dispatch remain exclusively
/// owned by `remote_execution`.
pub async fn internal_rpc_handler(
    Path(name): Path<String>,
    Extension(context): Extension<DeviceContext>,
    headers: HeaderMap,
    State(state): State<SharedState>,
    body: Result<Json<Value>, JsonRejection>,
) -> Response {
    let observation = super::metrics::RpcObservation::start(super::metrics::RpcPlane::Internal);
    let Json(args) = match body {
        Ok(body) => body,
        Err(rejection) => {
            observation.finish(super::metrics::RpcOutcome::Error { saturated: false });
            return (
                rejection.status(),
                Json(json!({
                    "code": "invalid_json_request",
                    "message": "the request body must be valid JSON for this endpoint",
                    "requestId": uuid::Uuid::new_v4().to_string(),
                    "retryable": false,
                    "details": {},
                })),
            )
                .into_response();
        }
    };
    let idempotency_key = headers
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let request = super::remote_execution::ExecutionRequest::new(
        name,
        args,
        context,
        super::remote_execution::ExecutionTransport::Internal,
        idempotency_key,
    )
    .with_traceparent(
        headers
            .get("traceparent")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned),
    );
    match super::remote_execution::execute(&state, request).await {
        Ok(super::remote_execution::ExecutionOutcome::Completed {
            operation_id,
            result,
            replayed,
            ..
        }) => {
            if replayed {
                super::metrics::record_operation(super::metrics::OperationOutcome::Replayed);
            } else if operation_id.is_some() {
                super::metrics::record_operation(super::metrics::OperationOutcome::Completed);
            }
            observation.finish(super::metrics::RpcOutcome::Completed);
            (StatusCode::OK, Json(result)).into_response()
        }
        Ok(super::remote_execution::ExecutionOutcome::Accepted { operation_id, .. }) => {
            super::metrics::record_operation(super::metrics::OperationOutcome::Accepted);
            observation.finish(super::metrics::RpcOutcome::Accepted);
            (
                StatusCode::ACCEPTED,
                Json(json!({
                    "operationId": operation_id,
                    "status": "running",
                })),
            )
                .into_response()
        }
        Err(error) => {
            let saturated = matches!(
                error.status,
                StatusCode::TOO_MANY_REQUESTS | StatusCode::SERVICE_UNAVAILABLE
            );
            observation.finish(super::metrics::RpcOutcome::Error { saturated });
            let status = error.status;
            (status, Json(internal_execution_error_body(error))).into_response()
        }
    }
}

fn internal_execution_error_body(error: super::remote_execution::ExecutionError) -> Value {
    let mut body = serde_json::Map::from_iter([
        ("code".to_string(), Value::String(error.code)),
        ("message".to_string(), Value::String(error.message)),
        ("requestId".to_string(), Value::String(error.request_id)),
        ("retryable".to_string(), Value::Bool(error.retryable)),
        ("details".to_string(), error.details),
    ]);
    if let Some(operation_id) = error.operation_id {
        body.insert("operationId".to_string(), Value::String(operation_id));
    }
    Value::Object(body)
}

fn execution_error_response(error: super::remote_execution::ExecutionError) -> Response {
    let status = error.status;
    (status, Json(execution_error_body(error))).into_response()
}

fn completed_rpc_response(
    request_id: String,
    operation_id: Option<String>,
    result: Value,
) -> Value {
    let mut body = serde_json::Map::from_iter([
        ("requestId".to_string(), Value::String(request_id)),
        ("result".to_string(), result),
    ]);
    if let Some(operation_id) = operation_id {
        body.insert("operationId".to_string(), Value::String(operation_id));
    }
    Value::Object(body)
}

fn execution_error_body(error: super::remote_execution::ExecutionError) -> Value {
    let mut detail = serde_json::Map::from_iter([
        ("code".to_string(), Value::String(error.code)),
        ("message".to_string(), Value::String(error.message)),
        ("requestId".to_string(), Value::String(error.request_id)),
        ("retryable".to_string(), Value::Bool(error.retryable)),
        ("details".to_string(), error.details),
    ]);
    if let Some(operation_id) = error.operation_id {
        detail.insert("operationId".to_string(), Value::String(operation_id));
    }
    json!({ "error": detail })
}

fn authenticate_device_request(
    _state: &SharedState,
    request: &Request,
) -> Result<DeviceContext, ApiError> {
    let token = bearer_token(request.headers())?;
    let access = decode_access_token(token)?;
    let security = store()?;
    let snapshot = security
        .authorization_snapshot(&access.tenant_id, &access.sub)
        .map_err(store_error)?
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::UNAUTHORIZED,
                "device_unavailable",
                "the device is unknown or revoked",
            )
        })?;
    if snapshot.key_thumbprint != access.cnf.key_thumbprint {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "token_key_mismatch",
            "the access token is not bound to the active device key",
        ));
    }

    let path = request.uri().path();
    if let Some(command_name) = path
        .strip_prefix("/api/_rpc/")
        .filter(|name| !name.is_empty())
    {
        let descriptor = super::command_manifest::descriptor(command_name).ok_or_else(|| {
            ApiError::new(
                StatusCode::NOT_FOUND,
                "unknown_command",
                "the requested command is not registered",
            )
        })?;
        if descriptor.target == CommandTarget::Client
            || descriptor.target == CommandTarget::Service
            || !descriptor.transports.contains(&CommandTransport::Http)
        {
            return Err(ApiError::new(
                StatusCode::FORBIDDEN,
                "command_transport_forbidden",
                "the command cannot run through a device HTTP transport",
            ));
        }
        if descriptor.idempotency == CommandIdempotency::Required {
            let valid_idempotency_key = request
                .headers()
                .get("idempotency-key")
                .and_then(|value| value.to_str().ok())
                .is_some_and(|value| uuid::Uuid::parse_str(value).is_ok());
            if !valid_idempotency_key {
                return Err(ApiError::new(
                    StatusCode::BAD_REQUEST,
                    "idempotency_key_required",
                    "a UUID Idempotency-Key is required for this command",
                ));
            }
        }
        if descriptor.idempotency == CommandIdempotency::Forbidden
            && request.headers().contains_key("idempotency-key")
        {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "idempotency_key_forbidden",
                "this command does not accept an Idempotency-Key",
            ));
        }
    }
    let proof = request
        .headers()
        .get("dpop")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::UNAUTHORIZED,
                "missing_device_proof",
                "a DPoP device proof is required",
            )
        })?;
    let verified_proof = verify_device_proof(
        &snapshot.public_key_pem,
        proof,
        &access.jti,
        request.method().as_str(),
        path,
        unix_time_secs(),
    )?;
    consume_device_proof(&access.tenant_id, &access.sub, &verified_proof)?;
    Ok(DeviceContext {
        device_id: access.sub,
        account_id: access.tenant_id,
        scope: "device".to_string(),
        granted_scopes: Vec::new(),
        authorization_capabilities: Some(snapshot.capabilities),
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorBody {
    error: ErrorDetail,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorDetail {
    code: String,
    message: String,
    request_id: String,
    retryable: bool,
    details: serde_json::Value,
}

#[derive(Debug)]
pub(crate) struct ApiError {
    status: StatusCode,
    code: String,
    message: String,
    retryable: bool,
}

impl ApiError {
    fn new(status: StatusCode, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            status,
            code: code.into(),
            message: message.into(),
            retryable: false,
        }
    }

    fn unavailable(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code: "security_store_unavailable".to_string(),
            message: message.into(),
            retryable: true,
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        public_error_response(
            self.status,
            self.code,
            self.message,
            self.retryable,
            json!({}),
        )
    }
}

/// Build the canonical public Companion error envelope used by HTTP handlers
/// and WebSocket upgrade rejections. Protocol frames keep their native error
/// shapes after a successful upgrade.
pub(crate) fn public_error_response(
    status: StatusCode,
    code: impl Into<String>,
    message: impl Into<String>,
    retryable: bool,
    details: Value,
) -> Response {
    (
        status,
        Json(ErrorBody {
            error: ErrorDetail {
                code: code.into(),
                message: message.into(),
                request_id: uuid::Uuid::new_v4().to_string(),
                retryable,
                details,
            },
        }),
    )
        .into_response()
}

type ApiResult<T> = Result<Json<T>, ApiError>;

fn parse_public_json<T>(body: Result<Json<T>, JsonRejection>) -> Result<T, ApiError> {
    body.map(|Json(value)| value).map_err(|rejection| {
        ApiError::new(
            rejection.status(),
            "invalid_json_request",
            "the request body must be valid JSON for this endpoint",
        )
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChallengeRequest {
    tenant_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChallengeResponse {
    challenge_id: String,
    nonce: String,
    expires_at: i64,
}

async fn challenge_handler(
    body: Result<Json<ChallengeRequest>, JsonRejection>,
) -> ApiResult<ChallengeResponse> {
    let request = parse_public_json(body)?;
    let tenant_id = request_tenant(request.tenant_id)?;
    let challenge = store()?
        .issue_challenge(&tenant_id, unix_time_secs(), CHALLENGE_TTL_SECS)
        .map_err(store_error)?;
    Ok(Json(ChallengeResponse {
        challenge_id: challenge.id,
        nonce: challenge.nonce,
        expires_at: challenge.expires_at,
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterRequest {
    tenant_id: Option<String>,
    invitation: Option<String>,
    challenge_id: String,
    challenge_nonce: String,
    device_id: String,
    display_name: String,
    public_key_pem: String,
    signaling_public_key: String,
    proof: String,
    /// ADR-0127: self-reported labels for the `companion://device-paired`
    /// event (`ios` | `android` | `web` | `unknown`). Optional — older
    /// clients omit them and the event falls back to `unknown`.
    #[serde(default)]
    platform: Option<String>,
    #[serde(default)]
    app_version: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RegisterResponse {
    device_id: String,
    tenant_id: String,
    role: &'static str,
    server_version: &'static str,
    signaling: SignalingRegistrationResponse,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerRegisterRequest {
    tenant_id: Option<String>,
    enrollment: String,
    challenge_id: String,
    challenge_nonce: String,
    device_id: String,
    display_name: String,
    public_key_pem: String,
    proof: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerRegisterResponse {
    device_id: String,
    tenant_id: String,
    role: &'static str,
    capabilities: [&'static str; 1],
    server_version: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SignalingRegistrationResponse {
    rendezvous_id: String,
    room_descriptor: RoomDescriptor,
}

/// Payload of `companion://device-paired` — mirrors `DevicePairedPayload` in
/// `lib/companion/event-bridge.ts` (snake_case, `account_id` == tenant id, the
/// same identity the device JWT carries as `account_id`).
#[derive(Debug, Clone, Serialize)]
pub(crate) struct DevicePairedEvent {
    pub device_id: String,
    pub account_id: String,
    /// Same value as `account_id`, under the key `ws::frame_visible_to_tenant`
    /// scopes on, so the frame only reaches subscribers of this tenant.
    #[serde(rename = "tenantId")]
    pub tenant_id: String,
    pub label: String,
    pub platform: String,
    pub pubkey: String,
    pub paired_at_ms: i64,
    pub app_version: String,
    pub rendezvous_id: String,
    pub room_descriptor: Value,
}

/// Emit `companion://device-paired` on the same rail as `device-seen`.
pub(crate) fn publish_device_paired(state: &SharedState, event: DevicePairedEvent) {
    let payload = serde_json::to_value(&event).unwrap_or(Value::Null);
    if let Some(app) = state.app_handle.clone() {
        use tauri::Emitter as _;
        let _ = app.emit("companion://device-paired", payload);
    } else {
        state
            .event_bus
            .publish("companion://device-paired".to_string(), payload);
    }
}

async fn register_handler(
    State(state): State<SharedState>,
    headers: HeaderMap,
    body: Result<Json<RegisterRequest>, JsonRejection>,
) -> ApiResult<RegisterResponse> {
    let request = parse_public_json(body)?;
    let authority = registration_authority(&headers, request.tenant_id.as_deref()).await?;
    let _ = verify_device_proof(
        &request.public_key_pem,
        &request.proof,
        &request.challenge_nonce,
        "POST",
        "/api/auth/device/register",
        unix_time_secs(),
    )?;
    let thumbprint = hex::encode(Sha256::digest(request.public_key_pem.as_bytes()));
    let security = store()?;
    let invitation = match (authority.requires_invitation, request.invitation.as_deref()) {
        (true, Some(invitation)) if !invitation.is_empty() => Some(invitation),
        (true, _) => {
            return Err(ApiError::new(
                StatusCode::FORBIDDEN,
                "owner_invitation_required",
                "a one-time owner invitation is required",
            ))
        }
        (false, Some(_)) => {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "owner_invitation_forbidden",
                "OIDC registration must not include an Owner invitation",
            ))
        }
        (false, None) => None,
    };
    let signaling = provision_signaling(&request.device_id, &request.signaling_public_key)?;
    let registration_result = if authority.requires_invitation {
        security.register_owner_device(
            &authority.tenant_id,
            invitation.expect("validated Owner invitation"),
            &request.challenge_id,
            &request.challenge_nonce,
            &request.device_id,
            &request.display_name,
            &request.public_key_pem,
            &thumbprint,
            unix_time_secs(),
        )
    } else {
        security.register_oidc_device(
            &authority.tenant_id,
            &authority.actor_id,
            &request.challenge_id,
            &request.challenge_nonce,
            &request.device_id,
            &request.display_name,
            &request.public_key_pem,
            &thumbprint,
            authority.role,
            unix_time_secs(),
        )
    };
    if let Err(error) = registration_result {
        cleanup_signaling(&request.device_id)?;
        return Err(store_error(error));
    }
    if let Err(error) = super::signaling::refresh_installed_hub() {
        security
            .revoke_device(
                &authority.tenant_id,
                &authority.actor_id,
                &request.device_id,
                true,
                unix_time_secs(),
            )
            .map_err(store_error)?;
        cleanup_signaling(&request.device_id)?;
        return Err(ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "signaling_registration_activate_failed",
            error,
        ));
    }
    // ADR-0127: the pairing lifecycle event. `lib/companion/event-bridge.ts`
    // has listened for `companion://device-paired` since ADR-0021 to mirror
    // new devices into every client's `pairedDevices` table, but nothing ever
    // emitted it. Same rail as the middleware's `companion://device-seen`:
    // `app.emit` on desktop (the Tauri→bus forwarder fans it out to remote
    // subscribers), a direct bus publish on the headless server. Best-effort —
    // registration has already succeeded.
    publish_device_paired(
        &state,
        DevicePairedEvent {
            device_id: request.device_id.clone(),
            account_id: authority.tenant_id.clone(),
            tenant_id: authority.tenant_id.clone(),
            label: request.display_name.clone(),
            platform: request
                .platform
                .clone()
                .unwrap_or_else(|| "unknown".to_owned()),
            pubkey: request.public_key_pem.clone(),
            paired_at_ms: chrono::Utc::now().timestamp_millis(),
            app_version: request
                .app_version
                .clone()
                .unwrap_or_else(|| "unknown".to_owned()),
            rendezvous_id: signaling.rendezvous_id.clone(),
            room_descriptor: serde_json::to_value(&signaling.room_descriptor)
                .unwrap_or(Value::Null),
        },
    );
    Ok(Json(RegisterResponse {
        device_id: request.device_id,
        tenant_id: authority.tenant_id,
        role: authority.role,
        server_version: env!("CARGO_PKG_VERSION"),
        signaling,
    }))
}

async fn worker_register_handler(
    body: Result<Json<WorkerRegisterRequest>, JsonRejection>,
) -> ApiResult<WorkerRegisterResponse> {
    let request = parse_public_json(body)?;
    if request.enrollment.is_empty() {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "worker_enrollment_required",
            "a one-time worker enrollment is required",
        ));
    }
    let tenant_id = request_tenant(request.tenant_id)?;
    let _ = verify_device_proof(
        &request.public_key_pem,
        &request.proof,
        &request.challenge_nonce,
        "POST",
        "/api/auth/worker/register",
        unix_time_secs(),
    )?;
    let thumbprint = hex::encode(Sha256::digest(request.public_key_pem.as_bytes()));
    store()?
        .register_worker_device(
            &tenant_id,
            &request.enrollment,
            &request.challenge_id,
            &request.challenge_nonce,
            &request.device_id,
            &request.display_name,
            &request.public_key_pem,
            &thumbprint,
            unix_time_secs(),
        )
        .map_err(store_error)?;
    Ok(Json(WorkerRegisterResponse {
        device_id: request.device_id,
        tenant_id,
        role: "member",
        capabilities: ["agent.worker"],
        server_version: env!("CARGO_PKG_VERSION"),
    }))
}

fn provision_signaling(
    device_id: &str,
    client_public_key: &str,
) -> Result<SignalingRegistrationResponse, ApiError> {
    let paired_at_ms = chrono::Utc::now().timestamp_millis();
    let host_identity = SignalingIdentity::generate();
    let room_nonce = {
        let mut bytes = [0_u8; 16];
        rand::fill(&mut bytes);
        URL_SAFE_NO_PAD.encode(bytes)
    };
    let room_descriptor = build_room_descriptor(
        room_nonce,
        host_identity.public_key_base64(),
        client_public_key.to_string(),
        paired_at_ms.saturating_add(ROOM_DESCRIPTOR_TTL_MS),
    );
    validate_room_descriptor(&room_descriptor, paired_at_ms).map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_signaling_public_key",
            "signalingPublicKey must be an uncompressed P-256 public key",
        )
    })?;
    let key_ref = device_id.to_string();
    let private_key = URL_SAFE_NO_PAD.encode(host_identity.private_bytes());
    cognia_secrets::keyring_secrets::set(SIGNALING_KEY_NAMESPACE, &key_ref, &private_key).map_err(
        |_| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "signaling_key_store_failed",
                "the Host signaling identity could not be stored",
            )
        },
    )?;
    let registration = super::signaling::DeviceRegistration {
        device_id: device_id.to_string(),
        rendezvous_id: room_descriptor.room_id.clone(),
        room_descriptor: room_descriptor.clone(),
        signaling_key_ref: key_ref,
    };
    let Some(registration_store) = super::signaling::registration_store::installed() else {
        cleanup_signaling(device_id)?;
        return Err(ApiError::unavailable(
            "the signaling registration store is unavailable",
        ));
    };
    if registration_store
        .upsert(&registration, paired_at_ms)
        .is_err()
    {
        cleanup_signaling(device_id)?;
        return Err(ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "signaling_registration_store_failed",
            "the signaling registration could not be persisted",
        ));
    }
    Ok(SignalingRegistrationResponse {
        rendezvous_id: registration.rendezvous_id,
        room_descriptor,
    })
}

fn cleanup_signaling(device_id: &str) -> Result<(), ApiError> {
    let key_ref = match super::signaling::registration_store::installed() {
        Some(registration_store) => registration_store
            .remove_device(device_id)
            .map_err(|error| {
                ApiError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "signaling_registration_cleanup_failed",
                    error.to_string(),
                )
            })?
            .unwrap_or_else(|| device_id.to_string()),
        None => device_id.to_string(),
    };
    super::signaling::envelope::clear_signaling_key(&key_ref).map_err(|error| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "signaling_key_cleanup_failed",
            format!("the Host signaling identity could not be removed: {error}"),
        )
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TokenRequest {
    tenant_id: Option<String>,
    device_id: String,
    challenge_id: String,
    challenge_nonce: String,
    proof: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TokenResponse {
    access_token: String,
    token_type: &'static str,
    expires_in: i64,
}

#[derive(Debug, Serialize, Deserialize)]
struct Confirmation {
    #[serde(rename = "jkt")]
    key_thumbprint: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct AccessClaims {
    sub: String,
    tenant_id: String,
    scope: String,
    iat: i64,
    exp: i64,
    jti: String,
    cnf: Confirmation,
}

/// Process-ephemeral authority for five-minute Companion access tokens.
///
/// The durable Companion signing secret continues to sign loopback service
/// principals, but public device access tokens deliberately use a random key
/// that is never persisted. Restarting the process therefore invalidates all
/// outstanding access tokens while registered device keys remain usable for
/// an immediate challenge/proof refresh.
struct AccessTokenAuthority {
    key: [u8; 32],
}

impl AccessTokenAuthority {
    fn random() -> Self {
        let mut key = [0u8; 32];
        rand::fill(&mut key);
        Self { key }
    }

    #[cfg(test)]
    fn from_key(key: [u8; 32]) -> Self {
        Self { key }
    }

    fn issue(&self, claims: &AccessClaims) -> Result<String, jsonwebtoken::errors::Error> {
        encode(
            &Header::new(Algorithm::HS256),
            claims,
            &EncodingKey::from_secret(&self.key),
        )
    }

    fn decode(&self, token: &str) -> Result<AccessClaims, jsonwebtoken::errors::Error> {
        let mut validation = Validation::new(Algorithm::HS256);
        validation.set_required_spec_claims(&["exp", "sub"]);
        decode::<AccessClaims>(token, &DecodingKey::from_secret(&self.key), &validation)
            .map(|data| data.claims)
    }
}

async fn token_handler(
    body: Result<Json<TokenRequest>, JsonRejection>,
) -> ApiResult<TokenResponse> {
    let request = parse_public_json(body)?;
    let tenant_id = request_tenant(request.tenant_id)?;
    let security = store()?;
    let (public_key, thumbprint) = security
        .active_device_key(&tenant_id, &request.device_id)
        .map_err(store_error)?
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::UNAUTHORIZED,
                "device_unavailable",
                "the device is unknown or revoked",
            )
        })?;
    let _ = verify_device_proof(
        &public_key,
        &request.proof,
        &request.challenge_nonce,
        "POST",
        "/api/auth/token",
        unix_time_secs(),
    )?;
    security
        .consume_challenge(
            &tenant_id,
            &request.challenge_id,
            &request.challenge_nonce,
            unix_time_secs(),
        )
        .map_err(store_error)?;

    let now = unix_time_secs();
    let claims = AccessClaims {
        sub: request.device_id,
        tenant_id,
        scope: "device".into(),
        iat: now,
        exp: now.saturating_add(ACCESS_TOKEN_TTL_SECS),
        jti: uuid::Uuid::new_v4().to_string(),
        cnf: Confirmation {
            key_thumbprint: thumbprint,
        },
    };
    let access_token = ACCESS_TOKEN_AUTHORITY.issue(&claims).map_err(|_| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "token_issue_failed",
            "the access token could not be issued",
        )
    })?;
    Ok(Json(TokenResponse {
        access_token,
        token_type: "DPoP",
        expires_in: ACCESS_TOKEN_TTL_SECS,
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SocketTicketRequest {
    channel: SocketChannel,
    #[serde(default)]
    session_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
enum SocketChannel {
    Events,
    Terminal,
    Browser,
    Acp,
    Worker,
}

impl SocketChannel {
    fn capability(self) -> &'static str {
        match self {
            Self::Events => "host.observe",
            Self::Terminal => "terminal.open",
            Self::Browser | Self::Acp => "agent.run",
            Self::Worker => "agent.worker",
        }
    }

    fn binding(self, session_id: Option<&str>) -> Result<(String, &'static str), ApiError> {
        match (self, session_id) {
            (Self::Events, None) => Ok(("/ws/events".to_string(), "events")),
            (Self::Terminal, None) => Ok(("/ws/terminal".to_string(), "terminal")),
            (Self::Acp, None) => Ok(("/ws/acp".to_string(), "acp")),
            (Self::Worker, None) => Ok(("/ws/worker".to_string(), "worker")),
            (Self::Browser, Some(session_id)) if !session_id.is_empty() => {
                Ok((format!("/ws/browser/{session_id}"), "browser"))
            }
            (Self::Browser, _) => Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "browser_session_required",
                "browser socket tickets require a sessionId",
            )),
            (_, Some(_)) => Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "socket_ticket_resource_forbidden",
                "sessionId is only valid for browser socket tickets",
            )),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SocketTicketResponse {
    ticket: String,
    expires_in: i64,
}

async fn socket_ticket_handler(
    headers: HeaderMap,
    body: Result<Json<SocketTicketRequest>, JsonRejection>,
) -> ApiResult<SocketTicketResponse> {
    let request = parse_public_json(body)?;
    let (path, audience) = request.channel.binding(request.session_id.as_deref())?;
    let token = bearer_token(&headers)?;
    let access = decode_access_token(token)?;
    let snapshot = store()?
        .authorization_snapshot(&access.tenant_id, &access.sub)
        .map_err(store_error)?
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::UNAUTHORIZED,
                "device_unavailable",
                "the device is unknown or revoked",
            )
        })?;
    if snapshot.key_thumbprint != access.cnf.key_thumbprint {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "token_key_mismatch",
            "the access token is not bound to the active device key",
        ));
    }
    let proof = headers
        .get("dpop")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::UNAUTHORIZED,
                "missing_device_proof",
                "a DPoP device proof is required",
            )
        })?;
    let verified_proof = verify_device_proof(
        &snapshot.public_key_pem,
        proof,
        &access.jti,
        "POST",
        "/api/auth/socket-ticket",
        unix_time_secs(),
    )?;
    let security = store()?;
    consume_device_proof(&access.tenant_id, &access.sub, &verified_proof)?;
    let required_capability = request.channel.capability();
    if !snapshot
        .capabilities
        .iter()
        .any(|capability| capability == required_capability)
    {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "socket_capability_required",
            format!("the {required_capability} capability is required for this channel"),
        ));
    }
    if matches!(request.channel, SocketChannel::Browser) {
        super::browser_gateway::gateway()
            .session_for_principal(
                &access.tenant_id,
                &access.sub,
                request.session_id.as_deref().unwrap_or_default(),
            )
            .map_err(|error| ApiError::new(StatusCode::FORBIDDEN, error.code, error.message))?;
    }
    socket_channel_host_gate(
        request.channel,
        crate::terminal_host_service::terminal_remote_access_enabled().await,
    )?;
    let ticket = security
        .issue_socket_ticket(
            &access.tenant_id,
            &access.sub,
            &path,
            audience,
            unix_time_secs(),
            SOCKET_TICKET_TTL_SECS,
        )
        .map_err(store_error)?;
    Ok(Json(SocketTicketResponse {
        ticket,
        expires_in: SOCKET_TICKET_TTL_SECS,
    }))
}

/// Host-wide switches that refuse a channel outright, independent of who is
/// asking.
///
/// The remote-terminal switch is enforced again at the WebSocket upgrade, but
/// a browser cannot read a status code off a failed upgrade — it gets an
/// untyped `error` event and reports "connection failed", which sent users
/// hunting for a network fault instead of for the switch. Refusing the ticket
/// puts the reason in a response the client can read and name, and costs
/// nothing: a ticket the upgrade would reject anyway has no other use.
///
/// Split out as a pure function for the same reason `rpc::terminal_rpc_authorization`
/// is — the handler around it needs a full DPoP-signed access token to reach.
fn socket_channel_host_gate(
    channel: SocketChannel,
    remote_terminal_enabled: bool,
) -> Result<(), ApiError> {
    if matches!(channel, SocketChannel::Terminal) && !remote_terminal_enabled {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "terminal_remote_access_disabled",
            "remote terminal access is disabled on this host",
        ));
    }
    Ok(())
}

fn decode_access_token(token: &str) -> Result<AccessClaims, ApiError> {
    let access = ACCESS_TOKEN_AUTHORITY.decode(token).map_err(|_| {
        ApiError::new(
            StatusCode::UNAUTHORIZED,
            "invalid_access_token",
            "the access token is invalid or expired",
        )
    })?;
    if access.scope != "device" {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "invalid_access_scope",
            "the access token scope is invalid",
        ));
    }
    Ok(access)
}

#[derive(Debug, Deserialize)]
struct DeviceProofClaims {
    nonce: String,
    htm: String,
    htu: String,
    iat: i64,
    exp: i64,
    jti: String,
}

struct VerifiedDeviceProof {
    jti: String,
    expires_at: i64,
}

fn verify_device_proof(
    public_key_pem: &str,
    proof: &str,
    nonce: &str,
    method: &str,
    path: &str,
    now: i64,
) -> Result<VerifiedDeviceProof, ApiError> {
    let key = DecodingKey::from_ec_pem(public_key_pem.as_bytes()).map_err(|_| {
        dpop_rejected(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_device_key",
            "the device public key is invalid",
        ))
    })?;
    let mut validation = Validation::new(Algorithm::ES256);
    validation.leeway = PROOF_CLOCK_SKEW_SECS as u64;
    validation.set_required_spec_claims(&["exp", "iat"]);
    let claims = decode::<DeviceProofClaims>(proof, &key, &validation)
        .map_err(|_| {
            dpop_rejected(ApiError::new(
                StatusCode::UNAUTHORIZED,
                "invalid_device_proof",
                "the device proof is invalid or expired",
            ))
        })?
        .claims;
    let fresh = claims.iat >= now.saturating_sub(PROOF_CLOCK_SKEW_SECS)
        && claims.iat <= now.saturating_add(PROOF_CLOCK_SKEW_SECS);
    if !fresh
        || claims.jti.is_empty()
        || claims.nonce != nonce
        || claims.htm != method
        || claims.htu != path
    {
        return Err(dpop_rejected(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "device_proof_mismatch",
            "the device proof does not match this request",
        )));
    }
    Ok(VerifiedDeviceProof {
        jti: claims.jti,
        expires_at: claims.exp,
    })
}

fn dpop_rejected(error: ApiError) -> ApiError {
    super::metrics::record_dpop_rejection();
    error
}

fn consume_device_proof(
    tenant_id: &str,
    device_id: &str,
    proof: &VerifiedDeviceProof,
) -> Result<(), ApiError> {
    let cache_key = format!("{tenant_id}\0{device_id}\0{}", proof.jti);
    let now = unix_time_secs();
    // jsonwebtoken accepts an expired proof within `PROOF_CLOCK_SKEW_SECS`, so
    // the replay entry must live through that same leeway window.
    let replay_expires_at = proof.expires_at.saturating_add(PROOF_CLOCK_SKEW_SECS);
    if DPOP_REPLAY_CACHE.mark_redeemed(&cache_key, replay_expires_at, now) {
        Ok(())
    } else {
        super::metrics::record_dpop_replay();
        Err(ApiError::new(
            StatusCode::CONFLICT,
            "device_proof_replay",
            "the device proof has already been used",
        ))
    }
}

struct RegistrationAuthority {
    tenant_id: String,
    actor_id: String,
    role: &'static str,
    requires_invitation: bool,
}

async fn registration_authority(
    headers: &HeaderMap,
    requested_tenant: Option<&str>,
) -> Result<RegistrationAuthority, ApiError> {
    match deployment_mode() {
        DeploymentMode::SingleUser => Ok(RegistrationAuthority {
            tenant_id: LOCAL_TENANT_ID.to_string(),
            actor_id: "local-trust-root".to_string(),
            role: "owner",
            requires_invitation: true,
        }),
        DeploymentMode::MultiTenant => {
            let authenticator = super::oidc_authenticator()
                .ok_or_else(|| ApiError::unavailable("tenant authentication is not configured"))?;
            let claims = authenticator
                .authenticate(bearer_token(headers)?)
                .await
                .map_err(|_| {
                    ApiError::new(
                        StatusCode::UNAUTHORIZED,
                        "oidc_authentication_failed",
                        "the identity provider could not authenticate this request",
                    )
                })?;
            let tenant = claims
                .organization_id
                .clone()
                .unwrap_or_else(|| claims.sub.clone());
            if requested_tenant.is_some_and(|requested| requested != tenant) {
                return Err(ApiError::new(
                    StatusCode::FORBIDDEN,
                    "tenant_mismatch",
                    "the requested tenant does not match the authenticated tenant",
                ));
            }
            let role = if claims.scopes.iter().any(|scope| scope == "brain:admin") {
                "owner"
            } else {
                "member"
            };
            Ok(RegistrationAuthority {
                tenant_id: tenant,
                actor_id: claims.sub,
                role,
                requires_invitation: false,
            })
        }
    }
}

fn request_tenant(requested: Option<String>) -> Result<String, ApiError> {
    match deployment_mode() {
        DeploymentMode::SingleUser => Ok(LOCAL_TENANT_ID.to_string()),
        DeploymentMode::MultiTenant => requested
            .filter(|tenant| !tenant.trim().is_empty())
            .ok_or_else(|| {
                ApiError::new(
                    StatusCode::BAD_REQUEST,
                    "tenant_required",
                    "tenantId is required in multi-tenant mode",
                )
            }),
    }
}

fn bearer_token(headers: &HeaderMap) -> Result<&str, ApiError> {
    headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::UNAUTHORIZED,
                "missing_authorization",
                "an Authorization bearer token is required",
            )
        })
}

fn store() -> Result<std::sync::Arc<SecurityStore>, ApiError> {
    security_store().ok_or_else(|| ApiError::unavailable("the security database is unavailable"))
}

fn store_error(error: SecurityStoreError) -> ApiError {
    match error {
        SecurityStoreError::InvalidChallenge => ApiError::new(
            StatusCode::CONFLICT,
            "invalid_challenge",
            "the challenge is expired or already used",
        ),
        SecurityStoreError::InvalidInvitation => ApiError::new(
            StatusCode::FORBIDDEN,
            "invalid_owner_invitation",
            "the owner invitation is expired or already used",
        ),
        SecurityStoreError::DeviceUnavailable => ApiError::new(
            StatusCode::UNAUTHORIZED,
            "device_unavailable",
            "the device is unknown or revoked",
        ),
        SecurityStoreError::InvalidSocketTicket => ApiError::new(
            StatusCode::UNAUTHORIZED,
            "invalid_socket_ticket",
            "the socket ticket is invalid or already used",
        ),
        SecurityStoreError::IdempotencyConflict => ApiError::new(
            StatusCode::CONFLICT,
            "idempotency_conflict",
            "the idempotency key was already used with a different request",
        ),
        SecurityStoreError::InvalidPolicy => ApiError::new(
            StatusCode::PRECONDITION_REQUIRED,
            "signed_policy_required",
            "the host policy is invalid, expired, revoked, or does not cover this command",
        ),
        SecurityStoreError::InvalidRunTransition => ApiError::new(
            StatusCode::CONFLICT,
            "invalid_run_transition",
            "the operation is not in a state that permits this transition",
        ),
        SecurityStoreError::LastOwner => ApiError::new(
            StatusCode::CONFLICT,
            "last_owner",
            "the last owner cannot be revoked through the device API",
        ),
        SecurityStoreError::InvalidCapabilities => ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_device_capabilities",
            "the requested capability snapshot contains an invalid grant or removes required Owner authority",
        ),
        SecurityStoreError::Sqlite(_) => {
            ApiError::unavailable("the security database could not complete the request")
        }
    }
}

fn unix_time_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use parking_lot::RwLock;
    use std::sync::Arc;

    fn test_state() -> SharedState {
        Arc::new(super::super::CompanionState {
            secret: RwLock::new(vec![0_u8; 32]),
            deny_list: Arc::new(super::super::deny_list::DenyList::new()),
            app_handle: None,
            idempotency: Arc::new(super::super::idempotency::IdempotencyCache::new()),
            event_bus: super::super::event_bus::EventBus::new(),
            sync_bridge: super::super::sync_bridge::SyncBridge::new(),
            desktop_messages_bridge:
                super::super::desktop_messages_bridge::DesktopMessagesBridge::new(),
            desktop_writes_bridge: super::super::desktop_writes_bridge::DesktopWritesBridge::new(),
            sync_registry: super::super::sync_registry::SyncTableRegistry::with_defaults(),
            rate_limiter: super::super::rate_limit::RateLimiter::with_defaults(),
            push_tokens: super::super::push::PushTokenRegistry::new(),
        })
    }

    /// ADR-0127: with no Tauri app handle (headless server) the pairing event
    /// goes straight onto the EventBus with the exact snake_case shape
    /// `lib/companion/event-bridge.ts` parses.
    #[test]
    fn device_paired_publishes_the_bridge_payload_on_the_bus() {
        let state = test_state();
        let mut receiver = match state.event_bus.subscribe(None, 0) {
            super::super::event_bus::SubscribeResult::Ok { receiver, .. } => receiver,
            _ => panic!("subscribe"),
        };
        publish_device_paired(
            &state,
            DevicePairedEvent {
                device_id: "dev-1".into(),
                account_id: "tenant-a".into(),
                tenant_id: "tenant-a".into(),
                label: "Pixel".into(),
                platform: "android".into(),
                pubkey: "-----BEGIN PUBLIC KEY-----".into(),
                paired_at_ms: 1_700_000_000_000,
                app_version: "1.2.3".into(),
                rendezvous_id: "rv-1".into(),
                room_descriptor: json!({ "roomId": "r1" }),
            },
        );
        let frame = receiver.try_recv().expect("one frame published");
        assert_eq!(frame.event_type, "companion://device-paired");
        assert_eq!(frame.payload["device_id"], "dev-1");
        assert_eq!(frame.payload["account_id"], "tenant-a");
        // Tenant-scoped delivery key (see `ws::frame_visible_to_tenant`).
        assert_eq!(frame.payload["tenantId"], "tenant-a");
        assert_eq!(frame.payload["label"], "Pixel");
        assert_eq!(frame.payload["platform"], "android");
        assert_eq!(frame.payload["paired_at_ms"], 1_700_000_000_000_i64);
        assert_eq!(frame.payload["app_version"], "1.2.3");
        assert_eq!(frame.payload["rendezvous_id"], "rv-1");
        assert_eq!(frame.payload["room_descriptor"]["roomId"], "r1");
    }

    /// Older clients omit the self-reported labels; the request still parses.
    #[test]
    fn register_request_accepts_missing_platform_and_app_version() {
        let raw = json!({
            "challengeId": "c1",
            "challengeNonce": "n1",
            "deviceId": "dev-1",
            "displayName": "Pixel",
            "publicKeyPem": "pem",
            "signalingPublicKey": "spk",
            "proof": "p"
        });
        let parsed: RegisterRequest = serde_json::from_value(raw).expect("parses");
        assert!(parsed.platform.is_none());
        assert!(parsed.app_version.is_none());
        let with = json!({
            "challengeId": "c1", "challengeNonce": "n1", "deviceId": "dev-1",
            "displayName": "Pixel", "publicKeyPem": "pem", "signalingPublicKey": "spk",
            "proof": "p", "platform": "ios", "appVersion": "9.9.9"
        });
        let parsed: RegisterRequest = serde_json::from_value(with).expect("parses");
        assert_eq!(parsed.platform.as_deref(), Some("ios"));
        assert_eq!(parsed.app_version.as_deref(), Some("9.9.9"));
    }

    async fn response_json(response: Response) -> Value {
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("response body");
        serde_json::from_slice(&bytes).expect("JSON response")
    }

    fn access_claims(jti: &str) -> AccessClaims {
        let now = unix_time_secs();
        AccessClaims {
            sub: "device-a".into(),
            tenant_id: "tenant-a".into(),
            scope: "device".into(),
            iat: now,
            exp: now + ACCESS_TOKEN_TTL_SECS,
            jti: jti.into(),
            cnf: Confirmation {
                key_thumbprint: "thumbprint-a".into(),
            },
        }
    }

    #[test]
    fn access_tokens_are_bound_to_one_process_ephemeral_authority() {
        let first = AccessTokenAuthority::from_key([1; 32]);
        let restarted = AccessTokenAuthority::from_key([2; 32]);
        let token = first.issue(&access_claims("access-jti")).unwrap();

        assert_eq!(first.decode(&token).unwrap().sub, "device-a");
        assert!(restarted.decode(&token).is_err());
    }

    #[test]
    fn dpop_replay_cache_is_scoped_to_tenant_and_device() {
        let proof = VerifiedDeviceProof {
            jti: uuid::Uuid::new_v4().to_string(),
            expires_at: unix_time_secs() + 60,
        };

        assert!(consume_device_proof("tenant-a", "device-a", &proof).is_ok());
        let replay = consume_device_proof("tenant-a", "device-a", &proof).unwrap_err();
        assert_eq!(replay.code, "device_proof_replay");
        assert!(consume_device_proof("tenant-a", "device-b", &proof).is_ok());
        assert!(consume_device_proof("tenant-b", "device-a", &proof).is_ok());
    }

    #[test]
    fn socket_channels_have_server_owned_bindings() {
        assert_eq!(
            SocketChannel::Events.binding(None).unwrap(),
            ("/ws/events".to_string(), "events")
        );
        assert_eq!(
            SocketChannel::Terminal.binding(None).unwrap(),
            ("/ws/terminal".to_string(), "terminal")
        );
        assert_eq!(
            SocketChannel::Browser.binding(Some("session-a")).unwrap(),
            ("/ws/browser/session-a".to_string(), "browser")
        );
        assert_eq!(
            SocketChannel::Acp.binding(None).unwrap(),
            ("/ws/acp".to_string(), "acp")
        );
        assert_eq!(
            SocketChannel::Browser.binding(None).unwrap_err().code,
            "browser_session_required"
        );
        assert_eq!(
            SocketChannel::Events
                .binding(Some("session-a"))
                .unwrap_err()
                .code,
            "socket_ticket_resource_forbidden"
        );
        assert_eq!(SocketChannel::Events.capability(), "host.observe");
        assert_eq!(SocketChannel::Terminal.capability(), "terminal.open");
        assert_eq!(SocketChannel::Browser.capability(), "agent.run");
        assert_eq!(SocketChannel::Acp.capability(), "agent.run");
        assert_eq!(
            SocketChannel::Worker.binding(None).unwrap(),
            ("/ws/worker".to_string(), "worker")
        );
        assert_eq!(SocketChannel::Worker.capability(), "agent.worker");
    }

    /// A browser gets an untyped `error` event off a rejected WebSocket
    /// upgrade, so the switch has to refuse at ticket time or the UI can only
    /// say "connection failed".
    #[test]
    fn a_terminal_ticket_is_refused_by_name_when_the_host_switch_is_off() {
        let error = socket_channel_host_gate(SocketChannel::Terminal, false)
            .expect_err("a terminal ticket must not be issued while remote access is off");
        assert_eq!(error.code, "terminal_remote_access_disabled");
        assert_eq!(error.status, StatusCode::FORBIDDEN);

        socket_channel_host_gate(SocketChannel::Terminal, true)
            .expect("the switch being on is the whole point of the switch");
    }

    /// The switch is about terminals. Gating events/browser/acp/worker on it
    /// would take the rest of the companion surface down with it.
    #[test]
    fn the_terminal_switch_does_not_reach_other_channels() {
        for channel in [
            SocketChannel::Events,
            SocketChannel::Browser,
            SocketChannel::Acp,
            SocketChannel::Worker,
        ] {
            socket_channel_host_gate(channel, false)
                .unwrap_or_else(|_| panic!("{channel:?} must not depend on the terminal switch"));
        }
    }

    #[test]
    fn public_signaling_url_defaults_to_the_forwarded_same_origin() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-proto", "https".parse().unwrap());
        headers.insert("x-forwarded-host", "brain.example".parse().unwrap());
        assert_eq!(
            same_origin_signaling_url(&headers),
            "wss://brain.example/signaling"
        );
    }

    #[test]
    fn signaling_registration_rejects_non_p256_public_keys() {
        let error = provision_signaling("device-invalid", "not-a-p256-key").unwrap_err();
        assert_eq!(error.code, "invalid_signaling_public_key");
    }

    #[tokio::test]
    async fn error_envelope_has_request_id_and_retryability() {
        let response = ApiError::unavailable("down").into_response();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = response_json(response).await;
        assert_eq!(body["error"]["code"], "security_store_unavailable");
        assert_eq!(body["error"]["retryable"], true);
        assert!(uuid::Uuid::parse_str(body["error"]["requestId"].as_str().unwrap()).is_ok());
        assert_eq!(body["error"]["details"], json!({}));
    }

    #[tokio::test]
    async fn public_json_rejections_use_the_canonical_error_envelope() {
        use tower::ServiceExt as _;

        let response = post(challenge_handler)
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/challenge")
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from("{"))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = response_json(response).await;
        assert_eq!(body["error"]["code"], "invalid_json_request");
        assert_eq!(body["error"]["retryable"], false);
    }

    #[test]
    fn completed_rpc_envelope_omits_absent_optional_fields() {
        let body = completed_rpc_response("request-a".into(), None, json!({ "ok": true }));
        assert_eq!(
            body,
            json!({
                "requestId": "request-a",
                "result": { "ok": true },
            })
        );
        assert!(body.get("replayed").is_none());
        assert!(body.get("operationId").is_none());
    }

    #[test]
    fn rpc_error_envelope_omits_absent_operation_id() {
        let error = super::super::remote_execution::ExecutionError {
            status: StatusCode::BAD_REQUEST,
            code: "invalid_request".into(),
            message: "invalid".into(),
            request_id: "request-b".into(),
            retryable: false,
            details: json!({}),
            operation_id: None,
        };
        let body = execution_error_body(error);
        assert_eq!(body["error"]["requestId"], "request-b");
        assert!(body["error"].get("operationId").is_none());
    }

    #[tokio::test]
    async fn internal_rpc_adapter_uses_the_canonical_unknown_command_error() {
        let metric = "cognia_rpc_requests_total{plane=\"internal\",outcome=\"error\"}";
        let value = |text: &str| -> u64 {
            text.lines()
                .find(|line| line.starts_with(metric))
                .and_then(|line| line.split_whitespace().nth(1))
                .and_then(|value| value.parse().ok())
                .unwrap_or(0)
        };
        let before = value(&super::super::metrics::render_prometheus());
        let response = internal_rpc_handler(
            Path("not_registered".into()),
            Extension(DeviceContext {
                device_id: super::super::jwt::SERVICE_DEVICE_ID.into(),
                account_id: "local_acct_a".into(),
                scope: "service".into(),
                granted_scopes: Vec::new(),
                authorization_capabilities: None,
            }),
            HeaderMap::new(),
            State(test_state()),
            Ok(Json(json!({}))),
        )
        .await;

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(response_json(response).await["code"], "unknown_command");
        let after = value(&super::super::metrics::render_prometheus());
        assert!(after >= before + 1);
    }

    #[tokio::test]
    async fn internal_operation_lookup_is_principal_scoped_and_returns_receipts() {
        let store = SecurityStore::in_memory().unwrap();
        let operation_id = match store
            .begin_idempotent_operation(
                "tenant-a",
                "service-a",
                "host-a",
                "idempotency-a",
                "request-hash-a",
                10,
            )
            .unwrap()
        {
            super::super::security_store::IdempotencyDecision::Started { operation_id } => {
                operation_id
            }
            other => panic!("unexpected decision: {other:?}"),
        };
        store
            .mark_operation_running("tenant-a", &operation_id, 11)
            .unwrap();
        let receipt = json!({
            "httpStatus": 500,
            "error": {
                "code": "operation_interrupted",
                "message": "the service restarted before completion",
                "retryable": true,
                "details": {}
            }
        });
        store
            .complete_idempotent_operation(
                "tenant-a",
                "service-a",
                "idempotency-a",
                &receipt.to_string(),
                false,
                12,
            )
            .unwrap();
        let context = DeviceContext {
            device_id: "service-a".into(),
            account_id: "tenant-a".into(),
            scope: "service".into(),
            granted_scopes: Vec::new(),
            authorization_capabilities: None,
        };

        let found = internal_operation_response(
            Ok(store.clone()),
            &context,
            operation_id.clone(),
            "request-found".into(),
        );
        assert_eq!(found.status(), StatusCode::OK);
        let found_body = response_json(found).await;
        assert_eq!(found_body["operationId"], operation_id);
        assert_eq!(found_body["status"], "failed");
        assert_eq!(found_body["receipt"], receipt);

        let mut other_principal = context;
        other_principal.device_id = "service-b".into();
        let hidden = internal_operation_response(
            Ok(store),
            &other_principal,
            operation_id.clone(),
            "request-hidden".into(),
        );
        assert_eq!(hidden.status(), StatusCode::NOT_FOUND);
        let hidden_body = response_json(hidden).await;
        assert_eq!(hidden_body["code"], "operation_not_found");
        assert_eq!(hidden_body["requestId"], "request-hidden");
        assert_eq!(hidden_body["operationId"], operation_id);
    }

    #[tokio::test]
    async fn internal_rpc_json_rejections_keep_the_headless_error_shape() {
        use tower::ServiceExt as _;

        let service = DeviceContext {
            device_id: super::super::jwt::SERVICE_DEVICE_ID.into(),
            account_id: "local_acct_a".into(),
            scope: "service".into(),
            granted_scopes: Vec::new(),
            authorization_capabilities: None,
        };
        let response = Router::new()
            .route("/internal/_rpc/{name}", post(internal_rpc_handler))
            .layer(Extension(service))
            .with_state(test_state())
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/internal/_rpc/claude_sidecar_status")
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from("{"))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = response_json(response).await;
        assert_eq!(body["code"], "invalid_json_request");
        assert!(body.get("error").is_none());
    }

    #[test]
    fn policy_scope_comes_from_the_command_manifest() {
        let request = CreatePolicyRequest {
            capability: "process.spawn".into(),
            commands: vec!["mcp_server_start".into()],
            constraints: json!({
                "port": 47890,
            }),
            expires_at: 200,
        };
        assert!(validate_policy_request(&request, 100).is_ok());

        let unconstrained_process = CreatePolicyRequest {
            capability: "process.spawn".into(),
            commands: vec!["mcp_server_start".into()],
            constraints: json!({}),
            expires_at: 200,
        };
        assert!(validate_policy_request(&unconstrained_process, 100).is_err());

        let service_command = CreatePolicyRequest {
            capability: "process.spawn".into(),
            commands: vec!["secret_store_get".into()],
            constraints: json!({}),
            expires_at: 200,
        };
        assert!(validate_policy_request(&service_command, 100).is_err());

        let interactive_command = CreatePolicyRequest {
            capability: "agent.run".into(),
            commands: vec!["claude_restore".into()],
            constraints: json!({}),
            expires_at: 200,
        };
        assert!(validate_policy_request(&interactive_command, 100).is_err());
    }

    #[test]
    fn policy_constraints_are_a_strict_json_subset() {
        assert!(crate::companion_api::remote_execution::json_subset_matches(
            &json!({
                "executable": "/usr/bin/git",
                "cwd": "/workspace",
                "args": ["status"],
                "env": {
                    "LANG": "C",
                },
                "network": false,
            }),
            &json!({
                "policyId": "policy-a",
                "executable": "/usr/bin/git",
                "cwd": "/workspace",
                "args": ["status"],
                "env": {
                    "LANG": "C",
                },
                "network": false,
            }),
        ));
        assert!(
            !crate::companion_api::remote_execution::json_subset_matches(
                &json!({ "env": { "LANG": "C" } }),
                &json!({ "env": { "LANG": "C", "LD_PRELOAD": "/tmp/inject.dylib" } }),
            )
        );
        assert!(
            !crate::companion_api::remote_execution::json_subset_matches(
                &json!({ "args": ["status"] }),
                &json!({ "args": ["status", "--short"] }),
            )
        );
        assert!(
            !crate::companion_api::remote_execution::json_subset_matches(
                &json!({ "network": false }),
                &json!({ "network": true }),
            )
        );
    }
}
