//! Canonical Companion device-key authentication and API adapters.

use axum::{
    extract::{ConnectInfo, Path, Request, State},
    http::{header::AUTHORIZATION, HeaderMap, StatusCode},
    middleware::{from_fn, Next},
    response::{IntoResponse, Response},
    routing::post,
    Extension, Json, Router,
};
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::net::SocketAddr;

use super::{
    command_manifest::{CommandApproval, CommandIdempotency, CommandTarget, CommandTransport},
    deployment::{deployment_mode, DeploymentMode},
    middleware::DeviceContext,
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

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/api/auth/device/challenge", post(challenge_handler))
        .route("/api/auth/device/register", post(register_handler))
        .route("/api/auth/token", post(token_handler))
        .route("/api/auth/socket-ticket", post(socket_ticket_handler))
        .layer(from_fn(super::middleware::pre_auth_rate_limit))
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
    state: &SharedState,
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
    let access = decode_access_token(state, bearer_token(request.headers())?)?;
    let security = store()?;
    let (public_key, active_thumbprint) = security
        .active_device_key(&access.tenant_id, &access.sub)
        .map_err(store_error)?
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::UNAUTHORIZED,
                "device_unavailable",
                "the device is unknown or revoked",
            )
        })?;
    if active_thumbprint != access.cnf.key_thumbprint
        || !security
            .has_capability(&access.tenant_id, &access.sub, "host.admin")
            .map_err(store_error)?
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
    let proof_jti = verify_device_proof(
        &public_key,
        proof,
        &access.jti,
        request.method().as_str(),
        request.uri().path(),
        unix_time_secs(),
    )?;
    security
        .consume_proof_jti(
            &access.tenant_id,
            &access.sub,
            &proof_jti,
            unix_time_secs().saturating_add(PROOF_CLOCK_SKEW_SECS),
            unix_time_secs(),
        )
        .map_err(store_error)?;
    Ok(DeviceContext {
        device_id: access.sub,
        account_id: access.tenant_id,
        scope: "owner".to_string(),
        granted_scopes: Vec::new(),
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
pub struct InvitationRequest {
    ttl_seconds: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InvitationResponse {
    invitation: String,
    expires_in: i64,
}

pub(crate) async fn invitation_handler(
    Extension(context): Extension<DeviceContext>,
    Json(request): Json<InvitationRequest>,
) -> ApiResult<InvitationResponse> {
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
    Json(request): Json<CreatePolicyRequest>,
) -> ApiResult<super::security_store::HostPolicySummary> {
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
    Json(args): Json<serde_json::Value>,
) -> Response {
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
    );
    match super::remote_execution::execute(&state, request).await {
        Ok(super::remote_execution::ExecutionOutcome::Completed {
            request_id,
            operation_id,
            result,
            replayed,
        }) => (
            StatusCode::OK,
            Json(json!({
                "requestId": request_id,
                "operationId": operation_id,
                "replayed": replayed,
                "result": result,
            })),
        )
            .into_response(),
        Ok(super::remote_execution::ExecutionOutcome::Accepted {
            request_id,
            operation_id,
        }) => (
            StatusCode::ACCEPTED,
            Json(json!({
                "requestId": request_id,
                "operationId": operation_id,
                "status": "running",
            })),
        )
            .into_response(),
        Err(error) => execution_error_response(error),
    }
}

fn execution_error_response(error: super::remote_execution::ExecutionError) -> Response {
    (
        error.status,
        Json(json!({
            "error": {
                "code": error.code,
                "message": error.message,
                "requestId": error.request_id,
                "retryable": error.retryable,
                "details": error.details,
                "operationId": error.operation_id,
            }
        })),
    )
        .into_response()
}

fn authenticate_device_request(
    state: &SharedState,
    request: &Request,
) -> Result<DeviceContext, ApiError> {
    let token = bearer_token(request.headers())?;
    let access = decode_access_token(state, token)?;
    let security = store()?;
    let (public_key, active_thumbprint) = security
        .active_device_key(&access.tenant_id, &access.sub)
        .map_err(store_error)?
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::UNAUTHORIZED,
                "device_unavailable",
                "the device is unknown or revoked",
            )
        })?;
    if active_thumbprint != access.cnf.key_thumbprint {
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
    let proof_jti = verify_device_proof(
        &public_key,
        proof,
        &access.jti,
        request.method().as_str(),
        path,
        unix_time_secs(),
    )?;
    security
        .consume_proof_jti(
            &access.tenant_id,
            &access.sub,
            &proof_jti,
            unix_time_secs().saturating_add(PROOF_CLOCK_SKEW_SECS),
            unix_time_secs(),
        )
        .map_err(store_error)?;
    Ok(DeviceContext {
        device_id: access.sub,
        account_id: access.tenant_id,
        scope: "device".to_string(),
        granted_scopes: Vec::new(),
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
    code: &'static str,
    message: String,
    request_id: String,
    retryable: bool,
    details: serde_json::Value,
}

pub(crate) struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
    retryable: bool,
}

impl ApiError {
    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            retryable: false,
        }
    }

    fn unavailable(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code: "security_store_unavailable",
            message: message.into(),
            retryable: true,
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ErrorBody {
                error: ErrorDetail {
                    code: self.code,
                    message: self.message,
                    request_id: uuid::Uuid::new_v4().to_string(),
                    retryable: self.retryable,
                    details: json!({}),
                },
            }),
        )
            .into_response()
    }
}

type ApiResult<T> = Result<Json<T>, ApiError>;

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

async fn challenge_handler(Json(request): Json<ChallengeRequest>) -> ApiResult<ChallengeResponse> {
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
    proof: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RegisterResponse {
    device_id: String,
    role: &'static str,
}

async fn register_handler(
    headers: HeaderMap,
    Json(request): Json<RegisterRequest>,
) -> ApiResult<RegisterResponse> {
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
    if authority.requires_invitation {
        let invitation = request.invitation.ok_or_else(|| {
            ApiError::new(
                StatusCode::FORBIDDEN,
                "owner_invitation_required",
                "a one-time owner invitation is required",
            )
        })?;
        security
            .register_owner_device(
                &authority.tenant_id,
                &invitation,
                &request.challenge_id,
                &request.challenge_nonce,
                &request.device_id,
                &request.display_name,
                &request.public_key_pem,
                &thumbprint,
                unix_time_secs(),
            )
            .map_err(store_error)?;
    } else {
        security
            .register_oidc_device(
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
            .map_err(store_error)?;
    }
    Ok(Json(RegisterResponse {
        device_id: request.device_id,
        role: authority.role,
    }))
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

async fn token_handler(
    State(state): State<SharedState>,
    Json(request): Json<TokenRequest>,
) -> ApiResult<TokenResponse> {
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
    let access_token = encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(state.secret.read().as_slice()),
    )
    .map_err(|_| {
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
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
enum SocketChannel {
    Events,
    Terminal,
    Browser,
    Acp,
}

impl SocketChannel {
    fn binding(self) -> (&'static str, &'static str) {
        match self {
            Self::Events => ("/ws/events", "events"),
            Self::Terminal => ("/ws/terminal", "terminal"),
            Self::Browser => ("/ws/browser", "browser"),
            Self::Acp => ("/ws/acp", "acp"),
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
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(request): Json<SocketTicketRequest>,
) -> ApiResult<SocketTicketResponse> {
    let (path, audience) = request.channel.binding();
    let token = bearer_token(&headers)?;
    let access = decode_access_token(&state, token)?;
    let (public_key, active_thumbprint) = store()?
        .active_device_key(&access.tenant_id, &access.sub)
        .map_err(store_error)?
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::UNAUTHORIZED,
                "device_unavailable",
                "the device is unknown or revoked",
            )
        })?;
    if active_thumbprint != access.cnf.key_thumbprint {
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
    let proof_jti = verify_device_proof(
        &public_key,
        proof,
        &access.jti,
        "POST",
        "/api/auth/socket-ticket",
        unix_time_secs(),
    )?;
    let security = store()?;
    security
        .consume_proof_jti(
            &access.tenant_id,
            &access.sub,
            &proof_jti,
            unix_time_secs().saturating_add(PROOF_CLOCK_SKEW_SECS),
            unix_time_secs(),
        )
        .map_err(store_error)?;
    let ticket = security
        .issue_socket_ticket(
            &access.tenant_id,
            &access.sub,
            path,
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

fn decode_access_token(state: &SharedState, token: &str) -> Result<AccessClaims, ApiError> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.set_required_spec_claims(&["exp", "sub"]);
    let access = decode::<AccessClaims>(
        token,
        &DecodingKey::from_secret(state.secret.read().as_slice()),
        &validation,
    )
    .map_err(|_| {
        ApiError::new(
            StatusCode::UNAUTHORIZED,
            "invalid_access_token",
            "the access token is invalid or expired",
        )
    })?
    .claims;
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
    #[serde(rename = "exp")]
    _exp: i64,
    jti: String,
}

fn verify_device_proof(
    public_key_pem: &str,
    proof: &str,
    nonce: &str,
    method: &str,
    path: &str,
    now: i64,
) -> Result<String, ApiError> {
    let key = DecodingKey::from_ec_pem(public_key_pem.as_bytes()).map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_device_key",
            "the device public key is invalid",
        )
    })?;
    let mut validation = Validation::new(Algorithm::ES256);
    validation.leeway = PROOF_CLOCK_SKEW_SECS as u64;
    validation.set_required_spec_claims(&["exp", "iat"]);
    let claims = decode::<DeviceProofClaims>(proof, &key, &validation)
        .map_err(|_| {
            ApiError::new(
                StatusCode::UNAUTHORIZED,
                "invalid_device_proof",
                "the device proof is invalid or expired",
            )
        })?
        .claims;
    let fresh = claims.iat >= now.saturating_sub(PROOF_CLOCK_SKEW_SECS)
        && claims.iat <= now.saturating_add(PROOF_CLOCK_SKEW_SECS);
    if !fresh || claims.nonce != nonce || claims.htm != method || claims.htu != path {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "device_proof_mismatch",
            "the device proof does not match this request",
        ));
    }
    Ok(claims.jti)
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
        SecurityStoreError::ProofReplay => ApiError::new(
            StatusCode::CONFLICT,
            "device_proof_replay",
            "the device proof has already been used",
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

    #[test]
    fn socket_channels_have_server_owned_bindings() {
        assert_eq!(SocketChannel::Events.binding(), ("/ws/events", "events"));
        assert_eq!(
            SocketChannel::Terminal.binding(),
            ("/ws/terminal", "terminal")
        );
        assert_eq!(SocketChannel::Browser.binding(), ("/ws/browser", "browser"));
        assert_eq!(SocketChannel::Acp.binding(), ("/ws/acp", "acp"));
    }

    #[test]
    fn error_envelope_has_request_id_and_retryability() {
        let response = ApiError::unavailable("down").into_response();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
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
            commands: vec!["keyring_secret_get".into()],
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
